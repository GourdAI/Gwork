/**
 * 契约测试：文件变更卡钉底 + 思考/工具时序不被卡片打乱（2026-11 用户报障）。
 *
 * 用户原话：「文件变更卡怎么跑到这里了，之前不是在正文最后嘛，然后这个思考啥的
 * 怎么显示顺序都乱了，也没折叠啥的」。
 *
 * 真因（PC）：变更卡宿主 .fch-host 恒钉「页脚之前」，但卡片常在 run 收口【前】
 * 就落宿主（挂起段收口 / 迟到帧）；恢复段/后续正文与思考/工具经插入漏斗
 * insertBeforeActions 同样以页脚为锚，全部插到宿主【后面】——DOM 序变成
 * 「变更卡 → 后到的思考/正文」，流式期卡片压在过程区上方；整轮 Compact 的
 * tail 重排又按原相对序保序，折叠态卡片仍在思考之前。
 *
 * 钉死的契约：
 *  A. 插入漏斗：insertBeforeActions 的引用节点 = 首个 .fch-host（优先）→ 页脚，
 *     新内容永远进不了卡片下方。
 *  B. Compact tail 三档：其余白名单 2m+3 → 变更卡（.fch-host/.msg-run-changes-card）
 *     2m+3.5 → 页脚（meta/actions/time/trace）2m+3.9；折叠态恒
 *     「正文 → 错误/交互 → 变更卡 → 时长徽章/操作按钮」。
 *  C. .fch-host 进 KEEP_VISIBLE 白名单（宿主本身不是过程行，不得被折叠隐藏）。
 *  D. placeHostInBubble 保持「页脚之前」锚定 + 幂等（位置正确零移动）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.resolve(__dirname, '..', 'ui');
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

const msgJs = read(path.join(UI, 'js', 'app-message.js'));
const fchJs = read(path.join(UI, 'js', 'app-file-changes.js'));
const displayJs = read(path.join(UI, 'js', 'app-turn-display.js'));

function fnBody(src, name) {
    const clean = stripComments(src);
    const i = clean.indexOf('function ' + name + '(');
    assert.ok(i >= 0, '函数缺失: ' + name);
    const open = clean.indexOf('{', i);
    let d = 1, j = open + 1;
    while (j < clean.length && d > 0) {
        if (clean[j] === '{') d++;
        else if (clean[j] === '}') d--;
        j++;
    }
    return clean.slice(open + 1, j - 1);
}

/* ===== A. 插入漏斗越过 fch-host ===== */

test('★ A1 insertBeforeActions 引用节点优先取首个 .fch-host，其次页脚', () => {
    const body = fnBody(msgJs, 'insertBeforeActions');
    assert.match(body, /classList\.contains\('fch-host'\)/, '必须扫描宿主');
    assert.match(body, /var refNode = fchHost \|\| footer/, '宿主优先于页脚（新内容进不了卡片下方）');
    assert.match(body, /\$\(refNode\)\.before\(el\)/, '按引用节点插入');
    /* 只认气泡直接子级（卡内文件行不叫 fch-host，但防御性口径与 childHeadersOf 一致） */
    assert.match(body, /bubble\.children/, '扫直接子级，不穿透 querySelectorAll');
});

/* ===== B. Compact tail 三档（行为级：假 DOM 真跑 compactBubble） ===== */

/* 极简假 DOM（turn-compact.test.js 同款）：只实现模块用到的 API */
function el(tag, classes, opts) {
    classes = classes || [];
    const node = {
        nodeType: 1, tagName: (tag || 'div').toUpperCase(),
        _classes: new Set(classes), _attrs: {}, children: [], parentNode: null,
        textContent: (opts && opts.text) || '',
        classList: {
            contains: (c) => node._classes.has(c),
            add: (c) => node._classes.add(c),
            remove: (c) => node._classes.delete(c),
            toggle: (c) => {
                if (node._classes.has(c)) { node._classes.delete(c); return false; }
                node._classes.add(c); return true;
            }
        },
        get className() { return Array.from(node._classes).join(' '); },
        set className(v) { node._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); },
        setAttribute(k, v) { node._attrs[k] = String(v); },
        getAttribute(k) { return node._attrs[k] === undefined ? null : node._attrs[k]; },
        removeAttribute(k) { delete node._attrs[k]; },
        matches(sel) {
            return sel.split(',').map(s => s.trim()).some(s => {
                if (s.startsWith('.')) return node._classes.has(s.slice(1).split(/\s|>|\./)[0]);
                return false;
            });
        },
        querySelector(sel) { return queryAll(node, sel)[0] || null; },
        querySelectorAll(sel) { return queryAll(node, sel); },
        /* 真实 DOM 语义补件（F 组行为级测试需要）：childNodes 含文本节点，
           假 DOM 无文本节点故与 children 同源；nextSibling/firstChild 按位置推导 */
        get childNodes() { return node.children; },
        get firstChild() { return node.children[0] || null; },
        get firstElementChild() { return node.children[0] || null; },
        get nextSibling() {
            if (!node.parentNode) return null;
            const sibs = node.parentNode.children;
            return sibs[sibs.indexOf(node) + 1] || null;
        },
        appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
        insertBefore(c, ref) {
            const old = node.children.indexOf(c);
            if (old >= 0) node.children.splice(old, 1);
            c.parentNode = node;
            const i = ref ? node.children.indexOf(ref) : -1;
            if (i < 0) node.children.push(c); else node.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
        addEventListener(ev, fn) { (node._listeners = node._listeners || {})[ev] = fn; }
    };
    function queryAll(root, sel) {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        const want = new Set();
        const wantAttr = new Set();
        parts.forEach(p => {
            const m = p.match(/\.([\w-]+)/);
            if (m) want.add(m[1]);
            const a = p.match(/\[([\w-]+)(?:=|\])/);
            if (a) wantAttr.add(a[1]);
        });
        function walk(n, direct) {
            for (const c of n.children) {
                let hit = false;
                for (const w of want) if (c._classes.has(w)) hit = true;
                for (const w of wantAttr) if (c._attrs[w] !== undefined) hit = true;
                if (hit) out.push(c);
                if (!direct) walk(c, false);
            }
        }
        walk(root, sel.indexOf(':scope >') >= 0);
        return out;
    }
    return node;
}
global.document = global.document || { createElement: (t) => el(t, []) };

const api = require(path.join(UI, 'js', 'app-turn-display.js'));

test('★ B1 折叠态：变更卡（宿主/裸卡）恒排正文与错误之后、页脚之前', () => {
    const b = el('div', ['msg-bubble']);
    const think = el('div', ['thinking-block']);
    /* 用户截图形态：卡片先落位，思考/正文后到（DOM 序卡片在最前） */
    const host = el('div', ['fch-host']);
    host.appendChild(el('div', ['msg-run-changes-card']));
    const tool = el('div', ['tool-card']);
    const final = el('div', ['md-content'], { text: '最终正文' });
    const meta = el('div', ['msg-meta-row']);
    const actions = el('div', ['msg-actions']);
    [think, host, tool, final, meta, actions].forEach(n => b.appendChild(n));
    assert.equal(api.compactBubble(b, { ended: true }), true, '应折叠');
    const order = b.children.map(n => n.className);
    const iFinal = order.indexOf('md-content');
    const iHost = order.indexOf('fch-host');
    const iMeta = order.indexOf('msg-meta-row');
    const iActions = order.indexOf('msg-actions');
    assert.ok(iHost > iFinal, '变更卡必须在最终正文之后（用户：之前不是在正文最后嘛）');
    assert.ok(iHost < iMeta && iMeta < iActions, '变更卡在时长徽章/操作按钮之前');
    /* 幂等：重跑顺序不变 */
    api.compactBubble(b, { ended: true });
    assert.deepEqual(b.children.map(n => n.className), order, '重跑幂等');
});

test('★ B2 裸卡（历史回放 .msg-run-changes-card 直挂）同样钉底，错误块在卡之前', () => {
    const b = el('div', ['msg-bubble']);
    const card = el('div', ['msg-run-changes-card']);
    const think = el('div', ['thinking-block']);
    const final = el('div', ['md-content'], { text: '正文' });
    const err = el('div', ['hitl-card']);   /* 白名单非页脚：其余 tail 档 */
    const meta = el('div', ['msg-meta-row']);
    [card, think, final, err, meta].forEach(n => b.appendChild(n));
    assert.equal(api.compactBubble(b, { ended: true }), true);
    const order = b.children.map(n => n.className);
    assert.ok(order.indexOf('msg-run-changes-card') > order.indexOf('md-content'), '卡在正文后');
    assert.ok(order.indexOf('msg-run-changes-card') > order.indexOf('hitl-card'), '卡在其余 tail 白名单后');
    assert.ok(order.indexOf('msg-run-changes-card') < order.indexOf('msg-meta-row'), '卡在页脚前');
});

/* ===== C. 白名单 + D. 宿主锚定 ===== */

test('★ C1 .fch-host 进 KEEP_VISIBLE 白名单（宿主不得被折叠隐藏）', () => {
    const clean = stripComments(displayJs);
    const m = clean.match(/var KEEP_VISIBLE_SELECTOR = ([\s\S]*?);/);
    assert.ok(m, 'KEEP_VISIBLE_SELECTOR 缺失');
    assert.match(m[1], /\.fch-host/, '宿主必须在白名单');
    assert.match(m[1], /\.msg-run-changes-card/, '裸卡白名单保留');
});

test('★ D1 placeHostInBubble 保持页脚锚定 + 幂等；三档分区键在 compactBubble 内', () => {
    const ph = fnBody(fchJs, 'placeHostInBubble');
    assert.match(ph, /bubbleFooterOf\(bubble\)/, '页脚锚点保留');
    assert.match(ph, /host\.nextSibling !== footer/, '位置正确零移动（幂等）');
    const cb = fnBody(displayJs, 'compactBubble');
    assert.match(cb, /isChangesCardAt\(c2\)/, '变更卡单独一档');
    assert.match(cb, /2 \* m \+ 3\.5/, '变更卡档 2m+3.5');
    assert.match(cb, /2 \* m \+ 3\.9/, '页脚档 2m+3.9（恒最后）');
    assert.match(cb, /isFooterAt\(c2\)/, '页脚判定含 meta/actions/time/trace');
});

/* ===== F. 行为级：insertBeforeActions 真跑（code review 补测）——
   既有 A1 只做源码形态断言，这里用假 DOM + 迷你 $ 桩把函数体真正执行，
   钉死用户报障的原始时序：卡片先落位（挂起段收口/迟到帧），恢复段思考/
   工具/正文后到，必须全部插到宿主之前，绝不压到卡片下方。 ===== */

function fakeSandbox(bubble, sess) {
    /* jQuery 子集桩：只实现 insertBeforeActions 用到的 API。
       before/append/find/first/[0]/text 均按真实语义实现（移动不复制）。 */
    function wrap(nodeOrArr) {
        const arr = Array.isArray(nodeOrArr) ? nodeOrArr : [nodeOrArr];
        return {
            0: arr[0],
            length: arr.length,
            find(sel) {
                const out = [];
                arr.forEach(n => { if (n && n.querySelectorAll) out.push(...n.querySelectorAll(sel)); });
                return wrap(out);
            },
            first() { return wrap(arr.slice(0, 1)); },
            before(el) { const ref = arr[0]; if (ref && ref.parentNode) ref.parentNode.insertBefore(el, ref); return this; },
            append(el) { const n = arr[0]; if (n) n.appendChild(el); return this; },
            text(v) { if (arr[0]) arr[0].textContent = String(v); return this; }
        };
    }
    return wrap;
}

function runInsert(sess, elFn) {
    const body = fnBody(msgJs, 'insertBeforeActions');
    /* 依赖注入：$ / ensureAssistantBubble / renderRoot / noteBatchInsert */
    const fn = new Function('sess', 'el', '$', 'ensureAssistantBubble', 'renderRoot', 'noteBatchInsert', body);
    return (sess, el, $, hooks) => fn(sess, el, $,
        (hooks && hooks.ensure) || function () {},
        (hooks && hooks.root) || function () { return null; },
        (hooks && hooks.note) || function () {});
}

test('★ F1 漏斗行为级：宿主先落位，后到思考/工具/正文全部插到宿主之前（用户报障时序真跑）', () => {
    const b = el('div', ['msg-bubble']);
    const md = el('div', ['md-content'], { text: '已有正文' });
    const host = el('div', ['fch-host']);
    host.appendChild(el('div', ['msg-run-changes-card']));
    const meta = el('div', ['msg-meta-row']);
    const actions = el('div', ['msg-actions']);
    [md, host, meta, actions].forEach(n => b.appendChild(n));
    const sess = { currentBubbleEl: md };
    const $ = fakeSandbox(b, sess);
    const insert = runInsert();
    const think = el('div', ['thinking-block']);
    const tool = el('div', ['tool-card']);
    const fresh = el('div', ['md-content'], { text: '恢复段正文' });
    insert(sess, think, $);
    insert(sess, tool, $);
    insert(sess, fresh, $);
    const order = b.children.map(n => n.className);
    const iHost = order.indexOf('fch-host');
    assert.ok(order.indexOf('thinking-block') < iHost, '后到思考必须在宿主之前');
    assert.ok(order.indexOf('tool-card') < iHost, '后到工具必须在宿主之前');
    assert.ok(order.lastIndexOf('md-content') < iHost, '恢复段正文必须在宿主之前');
    assert.ok(iHost < order.indexOf('msg-meta-row'), '宿主仍在页脚之前');
    /* 插入序号照盖（回滚契约依赖） */
    assert.ok(Number(think.getAttribute('data-ins-seq')) > 0, 'data-ins-seq 必须盖章');
    assert.ok(Number(tool.getAttribute('data-ins-seq')) > Number(think.getAttribute('data-ins-seq')), '序号单调递增');
});

test('★ F2 漏斗行为级：无宿主时退回页脚锚（旧行为零回归）；多宿主取首个', () => {
    const b = el('div', ['msg-bubble']);
    const md = el('div', ['md-content'], { text: '正文' });
    const meta = el('div', ['msg-meta-row']);
    [md, meta].forEach(n => b.appendChild(n));
    const sess = { currentBubbleEl: md };
    const $ = fakeSandbox(b, sess);
    const insert = runInsert();
    const tool = el('div', ['tool-card']);
    insert(sess, tool, $);
    let order = b.children.map(n => n.className);
    assert.ok(order.indexOf('tool-card') < order.indexOf('msg-meta-row'), '无宿主：插到页脚之前');
    /* 两个宿主（同 run 缝合后的极端形态）：新内容必须在【首个】宿主之前 */
    const h1 = el('div', ['fch-host']);
    const h2 = el('div', ['fch-host']);
    b.insertBefore(h1, meta);
    b.insertBefore(h2, meta);
    const late = el('div', ['thinking-block']);
    insert(sess, late, $);
    order = b.children.map(n => n.className);
    assert.ok(order.indexOf('thinking-block') < order.indexOf('fch-host'), '多宿主取首个：新内容在所有宿主之前');
});

test('★ F3 placeHostInBubble 行为级：收口后新内容晚于卡片到达时，宿主收敛回页脚之前（幂等）', () => {
    const ph = fnBody(fchJs, 'placeHostInBubble');
    const bf = fnBody(fchJs, 'bubbleFooterOf');
    const factory = new Function(bf.replace(/^/, 'function bubbleFooterOf(bubble){') + '}'
        + 'function placeHostInBubble(bubble, host){' + ph + '}'
        + 'return placeHostInBubble;');
    const place = factory();
    const b = el('div', ['msg-bubble']);
    const md = el('div', ['md-content'], { text: '正文' });
    const host = el('div', ['fch-host']);
    const meta = el('div', ['msg-meta-row']);
    [md, host, meta].forEach(n => b.appendChild(n));
    /* 迟到内容错误地压到了宿主之后（历史脏形态）：place 必须把宿主搬回页脚前 */
    const lateTool = el('div', ['tool-card']);
    b.insertBefore(lateTool, meta);
    let order = b.children.map(n => n.className);
    assert.ok(order.indexOf('fch-host') < order.indexOf('tool-card'), '前置：脏形态成立');
    place(b, host);
    order = b.children.map(n => n.className);
    assert.ok(order.indexOf('tool-card') < order.indexOf('fch-host'), '宿主收敛到内容流末尾');
    assert.equal(host.nextSibling, meta, '宿主紧贴页脚');
    /* 幂等：再跑一次零移动（同引用同位置） */
    const before = b.children.slice();
    place(b, host);
    assert.deepEqual(b.children, before, '位置正确时零移动');
});

test('★ E1 镜像同步：app-message/app-file-changes/app-turn-display 逐字一致', () => {
    const ROOT = path.resolve(__dirname, '..', '..', '..');
    /* gourd-ai-tauri 已随「桌面端统一 rust 内核」删除（7370119），不再是镜像目标；
       仅校验现存的 Java 静态资源镜像。桌面 UI 以本目录 ui/ 为唯一源。 */
    const mirrors = [
        path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static')
    ];
    for (const m of mirrors) {
        for (const f of ['js/app-message.js', 'js/app-file-changes.js', 'js/app-turn-display.js']) {
            assert.equal(read(path.join(UI, f)), read(path.join(m, f)), m + ' ' + f + ' 漂移');
        }
    }
});