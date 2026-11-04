/**
 * 契约测试：插话（steer）以用户消息气泡形态渲染 + 长文本折叠。
 *
 * 覆盖：
 * - app-message.js：steerNoteShouldCollapse 阈值（320 字 / 6 行边界）；
 *   appendSteerNote 行为（用户气泡族系 DOM：msg-row user + user-msg-col/msg-bubble/footer；
 *   身份徽标；data-user-msg-idx 同口径消耗计数器；复制按钮走 bindUserMsgCopyBtn 共用实现；
 *   附件走 renderUserAttachmentPaths 缩略图链路；轮次收尾三件套
 *   removeThinking/purgeInlineThinking/finishThinkingBlock；
 *   轮次边界不再走 advanceBodyPointer/insertBeforeActions，改为
 *   「收尾旧 currentBubbleEl 的 _streamMd → 清指针 → purgeEmptyMdBlocks(renderRoot) →
 *   _thinkingInterruptedByAction → ensureAssistantBubble」，且 purge 必须早于 ensure；
 *   滚动守卫（活动会话 + !_skipScroll + 落点非游离 + 容器在文档）；
 *   短文本原样、长文本加 .collapsed + 按钮、按钮切换展开/收起；
 *   字符超限但视觉不足 5 行时不折叠的高度校正口径；容器隐藏测不到高度时按阈值折叠
 *   并打 data-steer-collapse-pending，由 steerCollapseRemeasure 入真实容器后补测校正；
 *   去重守卫仍最优先）
 * - 折叠口径：CSS 限高必须是 calc(可见行数 × 行高em) 形态，系数取自源码常量
 *   STEER_COLLAPSE_VISIBLE_LINES，行高/字号取自 app.css 真实规则（13px × 1.75 = 22.75px/行）
 * - 源码形态：废弃的独立事件卡写法（.steer-note-text / .steer-note-attachments /
 *   insertBeforeActions(sess, note)）不得回归；window 导出（appendSteerNote /
 *   steerCollapseApply / steerCollapseRemeasure）对完整源码断言
 * - app.css：气泡列布局、身份徽标胶囊、折叠限高 + 渐隐遮罩、按钮样式；
 *   旧 grid 卡片样式（.steer-note { display: grid / ::before 图标）必须已移除
 * - 12 个语言包均提供 streaming.steer_expand_full（含 {0}）、steer_collapse、steer_tag
 * - gourd-ai-tauri/ui 发布副本与 static 源保持同步（4 个 js + css + 12 语言包）
 *
 * 变异支持：STEER_MUT_MESSAGE_SRC / STEER_MUT_CSS_SRC 环境变量可指向变异副本，
 * 供变异验证脚本在不触碰真实源文件的前提下证明断言真能抓错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const message = process.env.STEER_MUT_MESSAGE_SRC
    ? fs.readFileSync(process.env.STEER_MUT_MESSAGE_SRC, 'utf8').replace(/^\uFEFF/, '')
    : readStatic('js', 'app-message.js');
const appCss = process.env.STEER_MUT_CSS_SRC
    ? fs.readFileSync(process.env.STEER_MUT_CSS_SRC, 'utf8').replace(/^\uFEFF/, '')
    : readStatic('css', 'app.css');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

/* 镜像同步清单：插话/附件这批修复同时改动了消息渲染、队列面板、回放与流式分发四个 js，
   漏同步任意一个都会让 Tauri 发布副本出现「网页端已修、桌面端仍旧」的分叉。 */
const MIRROR_FILES = [
    ['js', 'app-message.js'],
    ['js', 'app-ui.js'],
    ['js', 'app-history.js'],
    ['js', 'app-streaming.js'],
    ['css', 'app.css'],
];

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, '未找到起始标记: ' + startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, '未找到结束标记: ' + endMarker);
    return source.slice(start, end + endMarker.length);
}

/* 剥掉注释后的「可执行源码」：注释里大量正引用被废弃的写法（解释为什么不能这么写），
   直接对原文断言会把这些说明当成违规。 */
function codeOnly(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* CSS 规则块提取：按花括号配平扫描（先剥注释），返回选择器精确匹配的声明体。
   不用正则是因为 .msg-bubble 这类规则前面是注释而非 } 或 ;，正则的前置锚点会漏匹配。 */
const CSS_BLOCKS = (function(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [];
    let depth = 0, sel = '', body = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '{') { if (depth === 0) { sel = body; body = ''; } else { body += c; } depth++; continue; }
        if (c === '}') { depth--; if (depth === 0) { blocks.push({ sel: sel.trim(), body: body.trim() }); sel = ''; body = ''; } else { body += c; } continue; }
        body += c;
    }
    return blocks;
})(appCss);
function cssRule(css, selector) {
    const hits = CSS_BLOCKS.filter(function(b) {
        return b.sel.split(',').map(function(s) { return s.trim(); }).indexOf(selector) >= 0;
    });
    assert.equal(hits.length, 1, 'app.css 中 ' + selector + ' 应恰好命中一个规则块，实际 ' + hits.length);
    return hits[0].body;
}
function cssDecl(block, prop) {
    const m = block.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
    assert.ok(m, '规则块缺少声明: ' + prop);
    return m[1].trim();
}

/* 折叠可见行数常量必须来自源码，避免测试里写死一份与产品各自漂移 */
const VISIBLE_LINES = Number((message.match(/var STEER_COLLAPSE_VISIBLE_LINES = (\d+);/) || [])[1]);
assert.ok(VISIBLE_LINES > 0, 'app-message.js 必须导出 STEER_COLLAPSE_VISIBLE_LINES 常量');

/* 从真实源码提取插话区块（常量 + 判定 + 折叠落地 + 补测 + 渲染），在沙箱中执行：
   微型 DOM/jQuery 桩实现本区块用到的 API（含 innerHTML 模板解析与 find 遍历），
   行为断言全部跑真实源码逻辑。 */
const steerBlock = sliceBetween(message, '/* 插话长文本折叠', 'window.appendSteerNote = appendSteerNote;');

function createSteerSandbox(opts) {
    opts = opts || {};
    const env = {
        existingSteerIds: opts.existingSteerIds || [],
        textScrollHeight: opts.textScrollHeight != null ? opts.textScrollHeight : 0,
        /* 真实口径：.msg-row.user .msg-bubble 是 13px，.msg-bubble 行高 1.75 → 22.75px/行 */
        lineHeight: opts.lineHeight || '22.75px',
        skipScroll: !!opts.skipScroll,
        detached: !!opts.detached,          // 回放期：落点是游离临时容器
        inDocument: opts.inDocument !== false,
    };
    const calls = {
        removeThinking: 0, purgeInlineThinking: 0, finishThinkingBlock: 0,
        ensureAssistantBubble: 0, insertBeforeActions: 0, advanceBodyPointer: 0,
        purgeEmptyMdBlocks: 0, scrollToBottom: 0, renderUserAttachmentPaths: 0,
        addImageLightbox: 0, bindUserMsgCopyBtn: 0, streamMdFinish: 0,
    };
    const order = [];   // 关键副作用的发生顺序（purge 必须早于 ensure）
    const attachArgs = [];
    const copyBtnArgs = [];

    function el(tag) {
        const node = {
            tagName: String(tag).toUpperCase(), className: '', textContent: '',
            attrs: {}, children: [], handlers: {}, scrollHeight: 0, parentNode: null,
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
            hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
            removeAttribute(k) { delete this.attrs[k]; },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            insertBefore(c, ref) {
                const i = ref ? this.children.indexOf(ref) : -1;
                c.parentNode = this;
                if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
                return c;
            },
            removeChild(c) {
                const i = this.children.indexOf(c);
                if (i >= 0) this.children.splice(i, 1);
                c.parentNode = null;
                return c;
            },
            remove() { if (this.parentNode) this.parentNode.removeChild(this); },
            addEventListener(t, fn) { (this.handlers[t] = this.handlers[t] || []).push(fn); },
        };
        let html = '';
        Object.defineProperty(node, 'innerHTML', {
            get() { return html; },
            set(v) { html = v; node.children = parseTemplate(v, node); },
        });
        return node;
    }
    /* 只解析本区块用到的 row 模板：
       user-msg-col > (msg-bubble, user-msg-footer > (msg-time, user-copy-btn)) */
    function parseTemplate(v, parent) {
        if (String(v).indexOf('user-msg-col') < 0) return [];
        const col = el('div'); col.className = 'user-msg-col';
        const bubble = el('div'); bubble.className = 'msg-bubble';
        const footer = el('div'); footer.className = 'user-msg-footer';
        const time = el('span'); time.className = 'msg-time user-msg-time';
        const copyBtn = el('button'); copyBtn.className = 'user-copy-btn';
        footer.appendChild(time);
        footer.appendChild(copyBtn);
        col.appendChild(bubble);
        col.appendChild(footer);
        parent.appendChild(col);
        return [col];
    }
    function descendants(node, out) {
        out = out || [];
        (node.children || []).forEach(function(c) { out.push(c); descendants(c, out); });
        return out;
    }
    function matches(elm, sel) {
        const mAttr = sel.match(/^\[data-steer-id="([^"]+)"\]$/);
        if (mAttr) return elm.getAttribute('data-steer-id') === mAttr[1];
        const mCls = sel.match(/^\.([\w-]+)$/);
        if (mCls) return (elm.className || '').split(/\s+/).indexOf(mCls[1]) >= 0;
        return false;
    }
    function findIn(root, sel) {
        const list = descendants(root).filter(function(e) { return matches(e, sel); });
        if (sel === '.user-msg-text' && list[0]) list[0].scrollHeight = env.textScrollHeight;
        const api = {
            length: list.length,
            0: list[0] || undefined,
            text(t) { if (list[0]) list[0].textContent = t; return api; },
            each(fn) { list.forEach(function(e, i) { fn.call(e, i, e); }); return api; },
            remove() { list.forEach(function(e) { e.remove(); }); return api; },
        };
        return api;
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
            removeClass(cls) { elm.className = (elm.className || '').split(/\s+/).filter(function(c) { return c && c !== cls; }).join(' '); return api; },
            hasClass(cls) { return (elm.className || '').split(/\s+/).indexOf(cls) >= 0; },
            toggleClass(cls) { return api.hasClass(cls) ? api.removeClass(cls) : api.addClass(cls); },
            attr(k, v) { if (v === undefined) return elm.attrs[k]; elm.setAttribute(k, v); return api; },
            on(t, fn) { elm.addEventListener(t, fn); return api; },
            text(t) { if (t === undefined) return elm.textContent; elm.textContent = t; return api; },
            append(c) { elm.appendChild(c && c[0] && c[0].tagName ? c[0] : c); return api; },
            find(sel) { return findIn(elm, sel); },
            remove() { elm.remove(); return api; },
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
    const sess = {
        container: el('div'),
        sessionId: 's1',
        activeRunId: opts.activeRunId || null,
        userMsgCounter: opts.userMsgCounter != null ? opts.userMsgCounter : 7,
        currentBubbleEl: opts.currentBubbleEl !== undefined ? opts.currentBubbleEl : null,
        _skipScroll: env.skipScroll,
        renderTarget: null,
    };
    /* 回放态：落点切到游离临时容器（不在文档中） */
    const tempDiv = el('div');
    if (env.detached) sess.renderTarget = tempDiv;
    const docNodes = env.inDocument ? [sess.container] : [];

    env.existingSteerIds.forEach(function(id) {
        const seed = el('div');
        seed.setAttribute('data-steer-id', id);
        (sess.renderTarget || sess.container).appendChild(seed);
    });
    const win = { getComputedStyle: function() { return { lineHeight: env.lineHeight }; } };
    const GourdI18n = { t: function(k, p) { return (p && p.length) ? k + '#' + p.join(',') : k; } };
    const doc = { contains: function(n) { return docNodes.indexOf(n) >= 0; } };

    const factory = new Function(
        'window', 'document', '$', 'GourdI18n', 'COPY_SVG', 'escapeHtml', 'renderMd', 'formatMsgTime',
        'addImageLightbox', 'bindUserMsgCopyBtn',
        'removeThinking', 'purgeInlineThinking', 'finishThinkingBlock', 'purgeEmptyMdBlocks',
        'renderUserAttachmentPaths', 'ensureAssistantBubble', 'insertBeforeActions', 'advanceBodyPointer',
        'activeSessionId', 'scrollToBottom', 'renderRoot', 'isDetachedRenderTarget',
        steerBlock + '\nreturn { steerNoteShouldCollapse: steerNoteShouldCollapse, appendSteerNote: appendSteerNote,'
        + ' steerCollapseApply: steerCollapseApply, steerCollapseRemeasure: steerCollapseRemeasure,'
        + ' STEER_COLLAPSE_MAX_CHARS: STEER_COLLAPSE_MAX_CHARS, STEER_COLLAPSE_MAX_LINES: STEER_COLLAPSE_MAX_LINES,'
        + ' STEER_COLLAPSE_VISIBLE_LINES: STEER_COLLAPSE_VISIBLE_LINES };'
    );
    const api = factory(
        win, doc, $, GourdI18n, '<svg/>',
        function(s) { return s; }, function(t) { return '<p>' + t + '</p>'; },
        function(ts) { return 't' + ts; },
        function() { calls.addImageLightbox++; },
        function(btn, bubble) { calls.bindUserMsgCopyBtn++; copyBtnArgs.push({ btn: btn, bubble: bubble }); },
        function() { calls.removeThinking++; order.push('removeThinking'); },
        function() { calls.purgeInlineThinking++; order.push('purgeInlineThinking'); },
        function() { calls.finishThinkingBlock++; order.push('finishThinkingBlock'); },
        function() { calls.purgeEmptyMdBlocks++; order.push('purgeEmptyMdBlocks'); },
        function(s, bubble, imgs, files) {
            calls.renderUserAttachmentPaths++;
            attachArgs.push({ bubble: bubble, imgs: imgs, files: files });
        },
        function() { calls.ensureAssistantBubble++; order.push('ensureAssistantBubble'); },
        function() { calls.insertBeforeActions++; order.push('insertBeforeActions'); },
        function() { calls.advanceBodyPointer++; order.push('advanceBodyPointer'); },
        's1',
        function() { calls.scrollToBottom++; order.push('scrollToBottom'); },
        function(s) { return s.renderTarget || s.container; },
        function(s) { return !!(s.renderTarget && s.renderTarget !== s.container); }
    );
    return {
        api: api, env: env, sess: sess, calls: calls, order: order,
        attachArgs: attachArgs, copyBtnArgs: copyBtnArgs, tempDiv: tempDiv,
        renderRoot: function() { return sess.renderTarget || sess.container; },
        getLastRow: function() {
            const kids = (sess.renderTarget || sess.container).children;
            return kids.length ? kids[kids.length - 1] : null;
        },
    };
}

function bubbleOf(row) {
    const col = (row.children || [])[0];
    if (!col) return null;
    return (col.children || []).find(function(c) { return (c.className || '').indexOf('msg-bubble') >= 0; });
}
function toggleOf(bubble) {
    return (bubble.children || []).find(function(c) { return (c.className || '').split(/\s+/).indexOf('steer-note-toggle') >= 0; });
}
function textElOf(row) {
    const bubble = bubbleOf(row);
    return (bubble.children || []).find(function(c) { return (c.className || '').indexOf('user-msg-text') >= 0; });
}
function footerOf(row) {
    const col = (row.children || [])[0];
    return (col.children || []).find(function(c) { return (c.className || '').indexOf('user-msg-footer') >= 0; });
}

test('steerNoteShouldCollapse：320 字 / 6 行边界判定', () => {
    const { api } = createSteerSandbox();
    assert.equal(api.STEER_COLLAPSE_MAX_CHARS, 320);
    assert.equal(api.STEER_COLLAPSE_MAX_LINES, 6);
    assert.equal(api.STEER_COLLAPSE_VISIBLE_LINES, VISIBLE_LINES, '常量必须与源码一致');
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

test('appendSteerNote：用户气泡族系 DOM + 身份徽标 + data-user-msg-idx + 复制按钮', () => {
    const h = createSteerSandbox({ userMsgCounter: 7 });
    h.api.appendSteerNote(h.sess, { steerId: 'st1', text: '这里插一句，注意保留现有行为。', createdAt: 1700000000000 });
    const row = h.getLastRow();
    assert.ok(row, '气泡行必须创建并入渲染落点');
    const cls = (row.className || '').split(/\s+/);
    assert.ok(cls.indexOf('msg-row') >= 0 && cls.indexOf('user') >= 0, '必须是用户消息行族系');
    assert.ok(cls.indexOf('steer-note') >= 0, '必须带插话身份类');
    assert.ok(cls.indexOf('wide-user') < 0, '短文本不得放宽宽度');
    assert.equal(row.getAttribute('data-steer-id'), 'st1');
    /* 插话也是用户输入：必须同口径消耗 userMsgCounter，否则输入历史面板定位不到它，
       且后续正常发送的序号出现空洞 */
    assert.equal(row.getAttribute('data-user-msg-idx'), '7', '必须写入 data-user-msg-idx');
    assert.equal(h.sess.userMsgCounter, 8, '计数器必须自增');

    const col = row.children[0];
    assert.equal(col.className, 'user-msg-col');
    const bubble = bubbleOf(row);
    assert.ok(bubble, '气泡必须存在');
    const badge = bubble.children[0];
    assert.equal(badge.className, 'steer-note-badge', '首子节点必须是插话身份徽标');
    assert.equal(badge.textContent, 'streaming.steer_tag');
    const textEl = bubble.children[1];
    assert.ok((textEl.className || '').indexOf('user-msg-text') >= 0, '正文必须是用户消息文本节点');
    assert.ok((textEl.className || '').indexOf('md-content') >= 0, '正文必须走 md 渲染');
    assert.equal(textEl.getAttribute('data-md-raw'), '这里插一句，注意保留现有行为。');
    const footer = footerOf(row);
    assert.ok(footer, '页脚必须存在');
    assert.equal(footer.children[0].textContent, 't1700000000000', '时间戳必须渲染');

    /* 复制按钮与正常发送共用 bindUserMsgCopyBtn（不再各写一份点击逻辑），
       且绑的是插话气泡本身（取 .user-msg-text 的 data-md-raw） */
    assert.equal(h.calls.bindUserMsgCopyBtn, 1, '插话页脚必须有复制按钮');
    assert.equal(h.copyBtnArgs[0].bubble, bubble, '复制按钮必须绑定插话气泡');
    const copyBtn = (footer.children || []).find(function(c) { return (c.className || '').indexOf('user-copy-btn') >= 0; });
    assert.ok(copyBtn, '页脚必须含 .user-copy-btn 节点');
    assert.equal(h.copyBtnArgs[0].btn, copyBtn);

    assert.equal(toggleOf(bubble), undefined, '短文本不得出现展开按钮');
    assert.ok(!(row.className || '').includes('collapsed'));
    assert.equal(h.calls.renderUserAttachmentPaths, 0, '无附件不得走附件链路');
    assert.equal(h.calls.addImageLightbox, 1);
});

test('appendSteerNote：轮次收尾三件套 + 轮次边界（清指针→purge→ensure），不再走正文指针推进', () => {
    const prevBubble = { _streamMd: { active: true, finish: function() { this.finished = (this.finished || 0) + 1; } } };
    const h = createSteerSandbox({ currentBubbleEl: prevBubble });
    h.api.appendSteerNote(h.sess, { steerId: 'st6', text: '打断一下' });

    assert.equal(h.calls.removeThinking, 1);
    assert.equal(h.calls.purgeInlineThinking, 1);
    assert.equal(h.calls.finishThinkingBlock, 1);
    /* 旧实现的轮次边界靠 advanceBodyPointer + insertBeforeActions：旧正文块为空时页脚锚点
       取到 null，新块静默成孤儿；非空时新块被插进旧气泡内部（插话上方），顺序颠倒。
       新语义是「插话之后开一条全新助手气泡」，两者都不得再被调用。 */
    assert.equal(h.calls.advanceBodyPointer, 0, '轮次边界不得再调 advanceBodyPointer');
    assert.equal(h.calls.insertBeforeActions, 0, '轮次边界不得再调 insertBeforeActions');
    assert.equal(prevBubble._streamMd.finished, 1, '进行中的流式渲染器必须收尾');
    assert.equal(h.sess.currentBubbleEl, null, '正文指针必须清空，否则后续正文回灌插话前的气泡');
    assert.equal(h.sess._thinkingInterruptedByAction, true, '必须标记思考块被动作打断');
    assert.equal(h.calls.purgeEmptyMdBlocks, 1, '必须清扫指针遗留的空壳 md 块');
    assert.equal(h.calls.ensureAssistantBubble, 1, '必须强制新建助手气泡承接后续正文');
    assert.ok(h.order.indexOf('purgeEmptyMdBlocks') < h.order.indexOf('ensureAssistantBubble'),
        'purge 必须早于 ensure：先建新气泡再清扫会把刚建的空气泡当空壳删掉');
    assert.equal(h.calls.scrollToBottom, 1, '活动会话 + 落点在文档 → 必须滚动到底');
});

test('appendSteerNote：长文本折叠 + 按钮，点击切换展开/收起', () => {
    const h = createSteerSandbox({ textScrollHeight: 800 });
    const text = 'x'.repeat(500);
    h.api.appendSteerNote(h.sess, { steerId: 'st2', text: text });
    const row = h.getLastRow();
    assert.ok((row.className || '').includes('collapsed'), '长文本必须默认折叠');
    assert.ok((row.className || '').includes('wide-user'), '超 100 字必须放宽气泡宽度');
    assert.ok(!row.hasAttribute('data-steer-collapse-pending'), '可测量时不得打待补测标记');
    const btn = toggleOf(bubbleOf(row));
    assert.ok(btn, '必须出现展开按钮');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.textContent, 'streaming.steer_expand_full#' + text.length, '按钮文案带全文字数');

    btn.handlers.click[0]();
    assert.ok(!(row.className || '').includes('collapsed'), '点击后展开');
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.equal(btn.textContent, 'streaming.steer_collapse');

    btn.handlers.click[0]();
    assert.ok((row.className || '').includes('collapsed'), '再点后收起');
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.textContent, 'streaming.steer_expand_full#' + text.length);
});

test('appendSteerNote：折叠按钮只建一个（重复 apply 不叠加）', () => {
    const h = createSteerSandbox({ textScrollHeight: 800 });
    const text = 'x'.repeat(500);
    h.api.appendSteerNote(h.sess, { steerId: 'st7', text: text });
    const row = h.getLastRow();
    // 补测路径可能对同一行再跑一次：绝不能建出两个按钮或给同一按钮绑两次点击
    h.api.steerCollapseApply(row, text, true);
    const bubble = bubbleOf(row);
    const toggles = (bubble.children || []).filter(function(c) { return (c.className || '').indexOf('steer-note-toggle') >= 0; });
    assert.equal(toggles.length, 1, '同一行只能有一个展开按钮');
    assert.equal(toggles[0].handlers.click.length, 1, '同一按钮不得重复绑定点击');
});

test('appendSteerNote：字符数超限但视觉不足 5 行时不折叠（高度校正口径）', () => {
    /* 22.75px/行 × 5 行 = 113.75px；60px 只有约 2.6 行，属超长单行 token 的形态 */
    const h = createSteerSandbox({ textScrollHeight: 60 });
    h.api.appendSteerNote(h.sess, { steerId: 'st3', text: 'x'.repeat(400) });
    const row = h.getLastRow();
    assert.ok(!(row.className || '').includes('collapsed'), '视觉不足 5 行不得出现点了没变化的无效按钮');
    assert.equal(toggleOf(bubbleOf(row)), undefined);
});

test('appendSteerNote：落点在文档但测不到高度（scrollHeight=0）→ 按阈值折叠且不打补测标记', () => {
    /* canMeasure = !isDetachedRenderTarget：落点在真实容器（非游离）时 canMeasure=true，
       走高度校正分支；但 scrollHeight=0（如 display:none 的隐藏容器）时校正条件
       fullH>0 不满足，退回阈值判定 → 折叠。此时【不打】data-steer-collapse-pending：
       pending 只服务「游离临时容器」的回放期，落点已在文档无需二次补测。 */
    const h = createSteerSandbox({ textScrollHeight: 0 });
    h.api.appendSteerNote(h.sess, { steerId: 'st4', text: 'y'.repeat(400) });
    const row = h.getLastRow();
    assert.ok((row.className || '').includes('collapsed'), '测不到高度按阈值折叠，刷新后折叠态完整');
    assert.ok(toggleOf(bubbleOf(row)));
    assert.ok(!row.hasAttribute('data-steer-collapse-pending'),
        '落点已在文档（canMeasure=true）不打补测标记，pending 仅服务游离落点');
});

test('appendSteerNote：回放期落点游离时按阈值初判（canMeasure=false）并打待补测标记', () => {
    /* 落点在游离临时容器里 getComputedStyle/scrollHeight 恒为 0：
       若仍按「可测量」口径走高度校正，每条长插话都会被判成视觉不足而不折叠。 */
    const h = createSteerSandbox({ textScrollHeight: 0, detached: true });
    h.api.appendSteerNote(h.sess, { steerId: 'st8', text: 'z'.repeat(400) });
    const row = h.getLastRow();
    assert.equal(row.parentNode, h.tempDiv, '回放期必须落进临时容器');
    assert.ok((row.className || '').includes('collapsed'), '游离落点只按阈值初判');
    assert.equal(row.getAttribute('data-steer-collapse-pending'), '1');
});

test('steerCollapseRemeasure：入真实容器后补测——视觉不足则撤折叠与按钮，仍超长则补加', () => {
    // ① 初判折叠 → 补测发现只有 2 行 → 撤掉 collapsed 与按钮
    const h = createSteerSandbox({ textScrollHeight: 0, detached: true });
    const text = 'x'.repeat(400);
    h.api.appendSteerNote(h.sess, { steerId: 'st9', text: text });
    const row = h.getLastRow();
    assert.ok((row.className || '').includes('collapsed'));
    h.env.textScrollHeight = 45.5;    // 22.75 × 2 = 45.5px，确实不足 5 行
    row.removeAttribute('data-steer-collapse-pending');
    h.api.steerCollapseRemeasure(row);
    assert.ok(!(row.className || '').includes('collapsed'), '补测判定视觉不足必须撤销折叠');
    assert.equal(toggleOf(bubbleOf(row)), undefined, '无效按钮必须一并移除');

    // ② 未折叠但确实超长 → 补测后补上折叠与按钮
    const h2 = createSteerSandbox({ textScrollHeight: 0 });
    h2.api.appendSteerNote(h2.sess, { steerId: 'st10', text: '短文本' });
    const row2 = h2.getLastRow();
    assert.ok(!(row2.className || '').includes('collapsed'));
    textElOf(row2).setAttribute('data-md-raw', text);
    h2.env.textScrollHeight = 800;
    h2.api.steerCollapseRemeasure(row2);
    assert.ok((row2.className || '').includes('collapsed'), '补测发现超长必须补加折叠');
    assert.ok(toggleOf(bubbleOf(row2)), '补加折叠必须同时给出展开按钮');
});

test('appendSteerNote：滚动守卫——游离落点 / _skipScroll / 非活动会话 / 容器不在文档 均不抢滚动', () => {
    // ① 回放期落点游离
    const d = createSteerSandbox({ detached: true });
    d.api.appendSteerNote(d.sess, { steerId: 'g1', text: '回放中的插话' });
    assert.equal(d.calls.scrollToBottom, 0, '游离落点滚动无意义且会把用户从正在看的位置拽走');

    // ② 显式 _skipScroll（回放/静默渲染）
    const s = createSteerSandbox({ skipScroll: true });
    s.api.appendSteerNote(s.sess, { steerId: 'g2', text: '静默插话' });
    assert.equal(s.calls.scrollToBottom, 0, '_skipScroll 必须生效');

    // ③ 非活动会话
    const n = createSteerSandbox();
    n.sess.sessionId = 'other';
    n.api.appendSteerNote(n.sess, { steerId: 'g3', text: '后台会话插话' });
    assert.equal(n.calls.scrollToBottom, 0, '非活动会话不得抢当前视口');

    // ④ 容器已不在文档（会话被摘除）
    const o = createSteerSandbox({ inDocument: false });
    o.api.appendSteerNote(o.sess, { steerId: 'g4', text: '孤儿容器插话' });
    assert.equal(o.calls.scrollToBottom, 0, '容器不在文档时不得滚动');

    // ⑤ 反向确认：四条守卫全通过时必须滚动（否则守卫写反会把正常滚动也吞掉）
    const ok = createSteerSandbox();
    ok.api.appendSteerNote(ok.sess, { steerId: 'g5', text: '正常插话' });
    assert.equal(ok.calls.scrollToBottom, 1, '活动会话 + 落点在文档 → 必须滚动');
});

test('appendSteerNote：超 100 字必放宽气泡宽度（100 字阈值边界）', () => {
    /* 阈值必须与 appendUserMessage 同口径（text.length > 100）：
       没有边界用例时，把阈值改成 200/300 也能让既有用例全部通过。 */
    const h = createSteerSandbox({ textScrollHeight: 0 });
    h.api.appendSteerNote(h.sess, { steerId: 'w1', text: 'x'.repeat(101) });
    assert.ok((h.getLastRow().className || '').split(/\s+/).indexOf('wide-user') >= 0,
        '101 字（刚过阈值）必须放宽宽度');

    const h2 = createSteerSandbox({ textScrollHeight: 0 });
    h2.api.appendSteerNote(h2.sess, { steerId: 'w2', text: 'x'.repeat(100) });
    assert.ok((h2.getLastRow().className || '').split(/\s+/).indexOf('wide-user') < 0,
        '恰好 100 字不得放宽宽度');
    assert.match(message, /if \(text\.length > 100 \|\| \$\(span\)\.find\('pre'\)\.length > 0\) \$\(row\)\.addClass\('wide-user'\);/,
        '插话与正常用户发送必须共用同一个 100 字 / 含代码块阈值');
});

test('appendSteerNote：同 steerId 去重守卫最优先，不重复建卡', () => {
    const h = createSteerSandbox({ existingSteerIds: ['st1'] });
    h.api.appendSteerNote(h.sess, { steerId: 'st1', text: '重复帧' });
    assert.equal(h.sess.container.children.length, 1, '只有种子节点，不得新建气泡');
    assert.equal(h.calls.ensureAssistantBubble, 0);
    assert.equal(h.calls.advanceBodyPointer, 0);
    assert.equal(h.calls.purgeEmptyMdBlocks, 0);
    assert.equal(h.calls.scrollToBottom, 0);
});

test('appendSteerNote：缺 steerId / 空入参直接返回，不产生任何副作用', () => {
    const h = createSteerSandbox();
    h.api.appendSteerNote(h.sess, null);
    h.api.appendSteerNote(null, { steerId: 'x' });
    h.api.appendSteerNote(h.sess, { text: '没有 steerId' });
    assert.equal(h.sess.container.children.length, 0);
    assert.equal(h.calls.ensureAssistantBubble, 0);
    assert.equal(h.calls.scrollToBottom, 0);
});

test('appendSteerNote：附件走缩略图链路（路径原样透传），不再降级为数量徽标', () => {
    const h = createSteerSandbox();
    h.api.appendSteerNote(h.sess, {
        steerId: 'st5', text: '看图说话',
        imagePaths: ['uploads/a.png', 'uploads/b.png'], filePaths: ['uploads/c.txt'],
    });
    assert.equal(h.calls.renderUserAttachmentPaths, 1, '必须走已落盘附件缩略图链路');
    const arg = h.attachArgs[0];
    assert.deepEqual(arg.imgs, ['uploads/a.png', 'uploads/b.png']);
    assert.deepEqual(arg.files, ['uploads/c.txt']);
    const bubble = bubbleOf(h.getLastRow());
    assert.ok(arg.bubble === bubble, '附件必须挂进插话气泡');
    /* 断言真实 DOM 而不是 innerHTML：本桩的 innerHTML 是模板字符串缓存，
       附件节点是 appendChild 进去的，用 innerHTML.indexOf 判定属于恒真伪证 */
    const badges = (bubble.children || []).filter(function(c) {
        return String(c.className || '').split(/\s+/).indexOf('user-attach-badge') >= 0;
    });
    assert.equal(badges.length, 0, '不得再画数量徽标');
});

test('源码形态：用户气泡族系 + 轮次边界顺序 + 废弃写法不得回归', () => {
    const iPurge = steerBlock.indexOf('purgeInlineThinking(sess);');
    const iRow = steerBlock.indexOf("var row = $('<div>').addClass('msg-row user steer-note')");
    const iAppendRow = steerBlock.indexOf('$(renderRoot(sess)).append(row);');
    const iCollapse = steerBlock.indexOf('steerCollapseApply(row, text, canMeasure);');
    const iClearPtr = steerBlock.indexOf('sess.currentBubbleEl = null;');
    const iPurgeEmpty = steerBlock.indexOf('purgeEmptyMdBlocks(renderRoot(sess));');
    const iFlag = steerBlock.indexOf('sess._thinkingInterruptedByAction = true;');
    const iEnsure = steerBlock.indexOf('ensureAssistantBubble(sess);');
    assert.ok(iPurge >= 0 && iRow > iPurge, '轮次收尾必须先于建气泡');
    assert.ok(iAppendRow >= 0 && iCollapse > iAppendRow, '气泡入落点后才做折叠判定');
    assert.ok(iAppendRow >= 0 && iClearPtr > iAppendRow, '用户气泡插入必须先于清指针');
    assert.ok(iClearPtr >= 0 && iPurgeEmpty > iClearPtr, '清指针必须先于空壳清扫');
    assert.ok(iPurgeEmpty >= 0 && iFlag > iPurgeEmpty, '清扫后才标记思考被打断');
    assert.ok(iFlag >= 0 && iEnsure > iFlag, 'ensureAssistantBubble 必须是轮次边界最后一步');
    assert.match(steerBlock, /renderUserAttachmentPaths\(sess, bubble, steerImgs, steerFiles\)/);
    assert.match(steerBlock, /bindUserMsgCopyBtn\(\$\(row\)\.find\('\.user-copy-btn'\)\[0\], bubble\)/,
        '复制按钮必须走与 appendUserMessage 共用的 bindUserMsgCopyBtn');
    assert.match(steerBlock, /row\.setAttribute\('data-user-msg-idx', String\(sess\.userMsgCounter\+\+\)\)/,
        '插话必须同口径消耗用户消息序号');
    /* 可执行代码里不得再出现正文指针推进（注释里正引用它解释为什么不能用，故先剥注释） */
    const execCode = codeOnly(steerBlock);
    assert.ok(execCode.indexOf('advanceBodyPointer') < 0, '轮次边界不得再调 advanceBodyPointer');
    assert.ok(execCode.indexOf('insertBeforeActions') < 0, '轮次边界不得再调 insertBeforeActions');
    // 废弃的独立事件卡写法不得回归
    assert.ok(steerBlock.indexOf('.steer-note-text') < 0, '旧事件卡正文类不得回归');
    assert.ok(steerBlock.indexOf('steer-note-attachments') < 0, '旧事件卡附件容器不得回归');
    assert.ok(steerBlock.indexOf('insertBeforeActions(sess, note)') < 0, '旧事件卡插入方式不得回归');
    assert.ok(!/\.text\(item\.text \|\| ''\)/.test(steerBlock), '旧的无校正文本写法不得回归');
    /* 导出断言必须对完整源码：steerBlock 的切片本身就含结束标记，
       在切片上断言等于断言「切片器本身工作正常」，属恒真伪证 */
    assert.match(message, /window\.appendSteerNote = appendSteerNote;/, 'appendSteerNote 必须挂到 window（回放分支按名调用）');
    assert.match(message, /window\.steerCollapseRemeasure = steerCollapseRemeasure;/,
        'steerCollapseRemeasure 必须挂到 window（app-history.js 补测按名调用）');
    assert.match(message, /function steerCollapseApply\(row, text, canMeasure\)/, '折叠判定必须抽为可复用函数');
    assert.match(message, /function steerCollapseRemeasure\(row\)/, '补测必须抽为可复用函数');
});

test('app.css：气泡列布局 + 徽标胶囊 + 折叠限高 + 按钮；旧 grid 卡片已移除', () => {
    assert.match(appCss, /\.steer-note \.msg-bubble \{[^}]*display: flex/, '插话气泡必须列布局承载徽标/附件/正文/按钮');
    assert.match(appCss, /\.steer-note \.msg-bubble \{[^}]*flex-direction: column/);
    assert.match(appCss, /\.steer-note-badge \{[^}]*border-radius: 999px/, '身份徽标必须是胶囊');
    assert.match(appCss, /\.steer-note-badge \{[^}]*color: var\(--accent\)/);
    assert.match(appCss, /\.steer-note\.collapsed \.user-msg-text \{[^}]*mask-image/);
    assert.match(appCss, /\.steer-note-toggle \{[^}]*align-self: flex-start/);
    assert.match(appCss, /\.steer-note-toggle:hover/);
    // 旧独立事件卡样式必须已移除
    assert.doesNotMatch(appCss, /\.steer-note \{[^}]*display: grid/, '旧 grid 事件卡不得残留');
    assert.doesNotMatch(appCss, /\.steer-note::before/, '旧 ↳ 图标不得残留');
    assert.doesNotMatch(appCss, /\.steer-note-attachments/, '旧附件容器样式不得残留');
});

test('app.css 折叠限高：calc(可见行数 × 行高em)，口径取自真实 CSS 规则与源码常量', () => {
    /* 旧断言写死 max-height: 104px 并「证明」它等于 5 × 13 × 1.6，
       而 13px 字号 / 1.6 行高这个组合在 app.css 里根本不存在（气泡是 13px / 1.75）——
       那是把伪证算式当成契约。现在口径全部从真实源码提取。 */
    const bubbleRule = cssRule(appCss, '.msg-bubble');
    const userBubbleRule = cssRule(appCss, '.msg-row.user .msg-bubble');
    const collapsedRule = cssRule(appCss, '.steer-note.collapsed .user-msg-text');

    const lineH = Number(cssDecl(bubbleRule, 'line-height'));
    const fontPx = Number((cssDecl(userBubbleRule, 'font-size').match(/^([\d.]+)px$/) || [])[1]);
    assert.ok(lineH > 0, '.msg-bubble 必须声明 line-height');
    assert.ok(fontPx > 0, '.msg-row.user .msg-bubble 必须声明 font-size');
    const pxPerLine = fontPx * lineH;
    assert.equal(pxPerLine, 22.75, '真实行高 = 13px × 1.75 = 22.75px/行');

    // 限高必须是 calc(N × Xem) 形态，N 与源码常量、X 与真实行高逐一对齐
    const maxH = cssDecl(collapsedRule, 'max-height');
    const m = maxH.match(/^calc\(\s*(\d+)\s*\*\s*([\d.]+)em\s*\)$/);
    assert.ok(m, '折叠限高必须是 calc(行数 × 行高em) 形态，不得写死 px 值，实际: ' + maxH);
    assert.equal(Number(m[1]), VISIBLE_LINES,
        'calc 系数必须等于 STEER_COLLAPSE_VISIBLE_LINES（' + VISIBLE_LINES + '），否则折叠行数与按钮语义不符');
    assert.equal(Number(m[2]), lineH, 'calc 的 em 系数必须等于 .msg-bubble 的 line-height');
    assert.equal(Number(m[1]) * Number(m[2]) * fontPx, pxPerLine * VISIBLE_LINES,
        '限高换算回 px 必须等于 可见行数 × 真实行高');

    // 渐隐遮罩的起点必须落在最后一行之内（否则末行文字被整段削掉）
    const mask = cssDecl(collapsedRule, 'mask-image');
    const fade = mask.match(/calc\(100% - ([\d.]+)em\)/);
    assert.ok(fade, '遮罩必须用 calc(100% - Xem) 定位渐隐起点，实际: ' + mask);
    assert.ok(Number(fade[1]) > 0 && Number(fade[1]) < lineH,
        '渐隐高度（' + fade[1] + 'em）必须小于一行行高（' + lineH + 'em）');
    /* -webkit- 前缀版必须与标准版逐字一致：只改其中一个（或只加其中一个）
       会让 Safari/旧 WebView 与 Chromium 下的渐隐位置不同，而上面的断言看不到前缀版 */
    const webkitMask = cssDecl(collapsedRule, '-webkit-mask-image');
    assert.equal(webkitMask, mask,
        '-webkit-mask-image 必须与 mask-image 完全一致（两份声明不得各自漂移）');

    // 沙箱与源码注释也必须写真实口径，避免测试环境用一套行高、产品用另一套
    assert.equal(createSteerSandbox().env.lineHeight, pxPerLine + 'px',
        '沙箱默认 lineHeight 必须等于真实行高 22.75px');
    assert.ok(message.indexOf('22.75px/行') >= 0, 'app-message.js 的折叠说明必须写真实口径（22.75px/行）');
    assert.ok(message.indexOf('5 × 1.75em') >= 0, 'app-message.js 的折叠说明必须写 calc 同口径（5 × 1.75em）');
    /* app.css 折叠注释块也必须写真实口径：2026-10 自审抓到过「行为层已改 13px、
       注释仍写 14px/24.5px」的漂移——注释是后人改字号时的第一参照， drift 会
       误导人按旧值「还原」。数值从真实规则推导而非写死，字号再改时断言自动跟随。 */
    assert.ok(appCss.indexOf(pxPerLine + 'px/行') >= 0,
        'app.css 折叠限高注释必须写真实行高口径（' + pxPerLine + 'px/行），不得残留旧字号算式');
});

test('12 个语言包均提供 steer_expand_full（含 {0}）、steer_collapse、steer_tag', () => {
    for (const lang of LOCALES) {
        const raw = fs.readFileSync(path.join(staticRoot, 'locales', lang + '.json'), 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(raw);
        assert.ok(data.streaming, lang + ' 缺少 streaming 段');
        assert.ok(data.streaming.steer_expand_full && data.streaming.steer_expand_full.indexOf('{0}') >= 0,
            lang + ' steer_expand_full 缺失或缺少 {0} 占位符');
        assert.ok(data.streaming.steer_collapse, lang + ' steer_collapse 缺失');
        assert.ok(data.streaming.steer_tag, lang + ' steer_tag 缺失（身份徽标文案）');
    }
});

/* mirrorRoot 必须从 test/js 向上四级才到仓库根：__dirname = gourd-ai-agent/src/test/js，
   ../../../ 只到 gourd-ai-agent/（拼出 gourd-ai-agent/gourd-ai-tauri/ui，不存在）。
   旧写法配 existsSync 的静默早退 → 本用例恒空跑、从没真正比对过（假绿灯）。
   现在改用 node:test 的 skip 选项：目录不在时报告里会显式出现 SKIP 及原因，
   而不是伪装成通过。镜像（gourd-ai-tauri/ui）被 .gitignore 忽略，
   CI 干净检出时不存在，故保留「不在则跳过」的容错。 */
const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
const mirrorSkip = fs.existsSync(mirrorRoot)
    ? false
    : '镜像目录不存在（gourd-ai-tauri/ui 由构建生成且被 .gitignore 忽略，干净检出时无副本可比对）';

test('gourd-ai-tauri/ui 发布副本与 static 源保持同步（4 js + css + 12 语言包）', { skip: mirrorSkip }, () => {
    for (const parts of MIRROR_FILES) {
        const rel = parts.join('/');
        const mirrorPath = path.join(mirrorRoot, ...parts);
        assert.ok(fs.existsSync(mirrorPath), '镜像缺少文件: ' + rel);
        const src = fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
        const mirror = fs.readFileSync(mirrorPath, 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交: ' + rel);
    }
    for (const lang of LOCALES) {
        const rel = path.join('locales', lang + '.json');
        const src = fs.readFileSync(path.join(staticRoot, rel), 'utf8').replace(/^\uFEFF/, '');
        const mirror = fs.readFileSync(path.join(mirrorRoot, rel), 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请同步后再提交: ' + rel);
    }
});
