/**
 * 回归测试：正文指针「孤儿化」根因（2026-11-25 用户报障「卡片跑到上面 /
 * 工具帧展示不完全 / 思考跑出来了」，连续两个提交未修复）。
 *
 * 真因（真实帧日志 work-mwuj8chb + 浏览器逐帧追踪实锤）：
 * advanceBodyPointer 旧顺序是「先 remove 空旧 md → 再 insertFresh 新壳」。
 * remove 之后 sess.currentBubbleEl 仍指向已脱离 DOM 的旧节点（非 null 但
 * parentNode === null）；insertBeforeActions 的兜底守卫只判 null 不判游离，
 * ensureAssistantBubble 原样返回孤儿指针 → 兜底失败 → 新 md 被 append 进
 * 游离的 renderTarget（回放临时容器），此后整轮正文/思考/工具全部写进不可见
 * 容器：用户看到变更卡压在残缺过程区上方、工具帧只剩零星几个、思考平铺外漏。
 *
 * 修复（双保险）：
 *   1) advanceBodyPointer 先插新壳、再摘旧空壳 —— 指针交接全程不出现
 *      「非 null 但游离」的窗口；
 *   2) ensureAssistantBubble 把「游离」与「null」同等对待：脱离文档即重建。
 *
 * 本文件从真实源码提取两个函数真跑（new Function 沙箱 + 极简假 DOM），
 * 钉死：① 推进后指针必须挂在真实气泡上；② 旧空壳被清理；③ 孤儿指针自愈。
 * 变异护栏：把顺序退回「先 remove 再 insert」必须被 ① 捕获。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const UI = path.resolve(__dirname, '..', 'ui');
const src = fs.readFileSync(path.join(UI, 'js', 'app-message.js'), 'utf8').replace(/^﻿/, '');

/* 提取函数体：定位 function 名 → 首个 '{' → 配平到闭合 '}'（避免 CRLF/注释陷阱） */
function extractFn(name) {
    const idx = src.indexOf('function ' + name + '(');
    assert.ok(idx >= 0, '源码必须含 ' + name);
    const start = src.indexOf('{', idx);
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(idx, i + 1); }
    }
    throw new Error('函数 ' + name + ' 大括号不配平');
}

/* 极简假 DOM：只实现两个函数用到的 API（$ 包装、remove、parentNode、classList） */
function makeNode(cls) {
    const node = {
        nodeType: 1, tagName: 'DIV', parentNode: null, children: [],
        _classes: new Set((cls || '').split(/\s+/).filter(Boolean)),
        _attrs: {},
        classList: {
            contains: (c) => node._classes.has(c),
            add: (c) => node._classes.add(c),
            remove: (c) => node._classes.delete(c)
        },
        get className() { return Array.from(node._classes).join(' '); },
        setAttribute(k, v) { node._attrs[k] = String(v); },
        getAttribute(k) { return node._attrs[k] === undefined ? null : node._attrs[k]; },
        appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
        remove() { if (node.parentNode) { const p = node.parentNode; const i = p.children.indexOf(node); if (i >= 0) p.children.splice(i, 1); node.parentNode = null; } },
        get textContent() { return node._text || ''; },
        set textContent(v) { node._text = v; },
        get innerHTML() { return node._html || ''; },
        set innerHTML(v) { node._html = v; },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    return node;
}
/* jQuery 桩：覆盖两个函数用到的链式 API。
   find(sel) 需真实返回气泡内的 .md-content（ensureAssistantBubble 靠它取新指针），
   故节点补 innerHTML setter：按模板串生成 md-content/meta/actions 子节点。 */
function make$() {
    const wrap = (el) => {
        const w = {
            0: el, length: el ? 1 : 0,
            remove() { if (el && el.remove) el.remove(); return w; },
            addClass(c) { if (el && el.classList) c.split(/\s+/).forEach(x => x && el.classList.add(x)); return w; },
            append(c) { if (el && el.appendChild) el.appendChild(c && c[0] !== undefined ? c[0] : c); return w; },
            find(sel) {
                if (!el) return wrap(null);
                const cls = String(sel).replace(/^\./, '').split(/\s|>/)[0];
                /* 递归查找（真实 jQuery find 是后代选择器） */
                const search = (node) => {
                    for (const c of (node.children || [])) {
                        if (c.classList && c.classList.contains(cls)) return c;
                        const deep = search(c);
                        if (deep) return deep;
                    }
                    return null;
                };
                return wrap(search(el));
            },
            on() { return w; },
            hide() { return w; },
            attr() { return w; },
            text() { return w; },
            closest() { return wrap(null); }
        };
        return w;
    };
    return function (arg) {
        if (typeof arg === 'string' && arg.charAt(0) === '<') {
            const n = makeNode('');
            /* row.innerHTML = '...<div class="msg-bubble"><div class="md-content">...'
               简化：按模板里出现的类名生成对应子节点，挂到 row 下供 find 命中 */
            Object.defineProperty(n, 'innerHTML', {
                get() { return n._html || ''; },
                set(v) {
                    n._html = v;
                    /* 模板含 msg-bubble 时生成气泡子树（md/meta/actions 挂气泡下） */
                    if (String(v).indexOf('msg-bubble') >= 0) {
                        const bubble = makeNode('msg-bubble');
                        ['md-content', 'msg-meta-row', 'msg-actions'].forEach(c => {
                            if (String(v).indexOf(c) >= 0) bubble.appendChild(makeNode(c));
                        });
                        n.appendChild(bubble);
                    }
                },
                configurable: true
            });
            return wrap(n);
        }
        const el = arg && arg[0] !== undefined ? arg[0] : arg;
        return wrap(el);
    };
}

/* 沙箱：注入假 DOM/jQuery/依赖，真跑提取出的函数源码 */
function buildSandbox(opts) {
    opts = opts || {};
    const bubble = makeNode('msg-bubble');
    const initialMd = makeNode('md-content');
    bubble.appendChild(initialMd);
    const sess = {
        currentBubbleEl: initialMd,
        reasonBuffer: '',
        _replaying: !!opts.replaying,
        renderTarget: opts.detachedTarget || null,
        container: makeNode('messages-inner')
    };
    const inserted = [];
    const $ = make$();
    const deps = {
        $,
        isVisuallyEmptyMd: (el) => !el || !(el.textContent || '').trim(),
        removeThinking: () => {},
        assistantRowShouldShowHead: () => true,
        assistantIdentityHeaderHtml: () => '',
        renderRoot: (s) => s.renderTarget || s.container,
        addCodeBlockButtons: () => {},
        highlightCodeBlocks: () => {},
        getStreamMd: () => ({ finish: () => {}, active: false }),
        COPY_SVG: '', RERUN_SVG: '', CONTINUE_SVG: '', OK_SVG: '',
        navigator: {},
        setTimeout: () => {},
        activeSessionId: 'x'
    };
    /* insertFresh：模拟 insertBeforeActions 的关键守卫——
       指针游离时走 ensureAssistantBubble 兜底；仍游离则 append 进 renderRoot（坏路径）。 */
    const insertFresh = (el) => {
        inserted.push(el);
        if (!sess.currentBubbleEl || !sess.currentBubbleEl.parentNode) {
            sandbox.ensureAssistantBubble(sess);
        }
        if (sess.currentBubbleEl && sess.currentBubbleEl.parentNode) {
            sess.currentBubbleEl.parentNode.appendChild(el);
        } else {
            const root = deps.renderRoot(sess);
            if (root) root.appendChild(el);   // 坏路径：内容进游离容器
        }
    };
    const names = Object.keys(deps);
    const body = extractFn('advanceBodyPointer') + '\n' + extractFn('ensureAssistantBubble')
        + '\nreturn { advanceBodyPointer: advanceBodyPointer, ensureAssistantBubble: ensureAssistantBubble };';
    const factory = new Function(...names, body);
    const sandbox = factory(...names.map(n => deps[n]));
    return { sess, bubble, initialMd, inserted, sandbox, insertFresh };
}

test('推进正文指针后，新指针必须挂在真实气泡上（不得游离）', () => {
    const { sess, bubble, sandbox, insertFresh } = buildSandbox();
    sandbox.advanceBodyPointer(sess, sess, insertFresh);
    assert.ok(sess.currentBubbleEl, '推进后指针不得为 null');
    assert.ok(sess.currentBubbleEl.parentNode, '推进后指针必须有父节点（旧实现先 remove 旧 md 致指针游离，新壳被丢进游离容器）');
    assert.strictEqual(sess.currentBubbleEl.parentNode, bubble, '新指针必须挂在原气泡上');
    assert.ok(sess.currentBubbleEl.classList.contains('md-content'), '新指针必须是 md-content');
});

test('推进后旧空壳被清理，气泡内不残留空 md', () => {
    const { sess, bubble, initialMd, sandbox, insertFresh } = buildSandbox();
    sandbox.advanceBodyPointer(sess, sess, insertFresh);
    assert.strictEqual(initialMd.parentNode, null, '旧空壳应被摘除');
    const mdKids = bubble.children.filter(c => c.classList.contains('md-content'));
    assert.strictEqual(mdKids.length, 1, '气泡内只留一个新 md 壳');
    assert.strictEqual(mdKids[0], sess.currentBubbleEl);
});

test('有内容的旧壳不得被误删（只清空壳）', () => {
    const { sess, bubble, initialMd, sandbox, insertFresh } = buildSandbox();
    initialMd.textContent = '已有正文';
    sandbox.advanceBodyPointer(sess, sess, insertFresh);
    assert.strictEqual(initialMd.parentNode, bubble, '非空旧壳必须保留');
    assert.notStrictEqual(sess.currentBubbleEl, initialMd, '指针仍应推进到新壳');
});

test('ensureAssistantBubble 对孤儿指针自愈：脱离文档即重建，不得原样返回', () => {
    const { sess, sandbox } = buildSandbox();
    /* 人为制造孤儿：指针非 null 但已脱离 DOM（purge/回滚/清扫后的真实状态） */
    sess.currentBubbleEl.remove();
    assert.ok(sess.currentBubbleEl && !sess.currentBubbleEl.parentNode, '前置：指针已是孤儿');
    const r = sandbox.ensureAssistantBubble(sess);
    assert.ok(r, '必须返回可用指针');
    assert.ok(r.parentNode, '自愈后指针必须挂在真实气泡上（旧守卫只判 null，会原样返回孤儿）');
});

test('变异护栏：旧顺序 + 旧守卫（只判 null）必然产生游离指针', () => {
    /* 对照实现 = 修复前的真实组合：advanceBodyPointer 先 remove 再 insert，
       且 ensureAssistantBubble 只判 null（不判游离）。验证断言①确实能抓住该缺陷。 */
    const bubble = makeNode('msg-bubble');
    const initialMd = makeNode('md-content');
    bubble.appendChild(initialMd);
    const detachedRoot = makeNode('temp-div');   // 游离的 renderTarget
    const sess = { currentBubbleEl: initialMd, reasonBuffer: '', renderTarget: detachedRoot, container: makeNode('messages-inner') };
    const $ = make$();
    /* 旧守卫：只判 null，孤儿原样返回 */
    const oldEnsure = (s) => s.currentBubbleEl;
    /* 旧 insertFresh：指针游离时 ensure 兜底失败 → append 进 renderRoot */
    const oldInsertFresh = (el) => {
        if (!sess.currentBubbleEl || !sess.currentBubbleEl.parentNode) oldEnsure(sess);
        if (sess.currentBubbleEl && sess.currentBubbleEl.parentNode) sess.currentBubbleEl.parentNode.appendChild(el);
        else detachedRoot.appendChild(el);
    };
    /* 旧顺序：先 remove 空旧 md，再 insert */
    sess.reasonBuffer = '';
    if (!(sess.currentBubbleEl.textContent || '').trim()) $(sess.currentBubbleEl).remove();
    const freshMd = makeNode('md-content');
    oldInsertFresh(freshMd);
    sess.currentBubbleEl = freshMd;
    /* 缺陷复现：新壳进了游离容器，不在真实气泡上 */
    assert.notStrictEqual(sess.currentBubbleEl.parentNode, bubble,
        '旧顺序+旧守卫必然导致新壳脱离原气泡（本条失败说明对照没复现缺陷，测试本身失效）');
    assert.strictEqual(sess.currentBubbleEl.parentNode, detachedRoot, '新壳被丢进游离 renderTarget');
});
