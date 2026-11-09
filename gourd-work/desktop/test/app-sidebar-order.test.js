'use strict';
/* ===== test/app-sidebar-order.test.js =====
 * 侧栏拖动排序顺序层（app-sidebar-order.js）单测。
 * 覆盖：纯函数（computeOrder / move / sortBySaved / storage 读写清洗）
 *      + 真实事件流（用轻量 DOM 桩跑 mousedown→dragstart→dragover→drop→dragend）。
 * 不引入 jsdom：桩只需模块实际用到的 Element 最小子集。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const SO = require('../ui/js/app-sidebar-order.js');

function memoryStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        _map: m
    };
}

/* ---- 轻量 DOM 桩 ---- */
class El {
    constructor(tag, attrs) {
        this.tag = tag;
        this.attrs = Object.assign({}, attrs || {});
        this.children = [];
        this.parentNode = null;
        this._classes = new Set(String(this.attrs.class || '').split(/\s+/).filter(Boolean));
        this.listeners = {};
        this.rect = { top: 0, height: 20 };
    }
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; }
    setAttribute(n, v) {
        this.attrs[n] = String(v);
        if (n === 'class') this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    removeAttribute(n) { delete this.attrs[n]; if (n === 'class') this._classes = new Set(); }
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); }
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } return this; }
    get classList() {
        const self = this;
        return {
            add(...cs) { for (const c of cs) self._classes.add(c); self.attrs.class = [...self._classes].join(' '); },
            remove(...cs) { for (const c of cs) self._classes.delete(c); self.attrs.class = [...self._classes].join(' '); },
            contains(c) { return self._classes.has(c); }
        };
    }
    matches(sel) {
        if (sel.startsWith('[')) return this.hasAttribute(sel.slice(1, -1));
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        return false;
    }
    closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    descendants() {
        const out = [];
        const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.descendants().find((n) => n.matches(sel)) || null; }
    querySelectorAll(sel) {
        const sels = sel.split(',').map((s) => s.trim());
        return this.descendants().filter((n) => sels.some((s) => n.matches(s)));
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    getBoundingClientRect() { return this.rect; }
}

function dispatch(target, type, extra) {
    const ev = Object.assign({
        target,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        clientY: 0,
        dataTransfer: { effectAllowed: '', dropEffect: '', setData() {}, setDragImage() {} }
    }, extra || {});
    let node = target;
    while (node) {
        const fns = (node.listeners && node.listeners[type]) || [];
        for (const fn of fns.slice()) fn.call(node, ev);
        node = node.parentNode;
    }
    return ev;
}

function buildRows(list, type, key, ids) {
    const rows = ids.map((id) => {
        const r = new El('div', { class: 'sidebar-item', 'data-drag-type': type, 'data-drag-key': key, 'data-drag-id': id });
        const handle = new El('span', { class: 'sidebar-drag-handle' });
        r.append(handle);
        r._handle = handle;
        return r;
    });
    for (const r of rows) list.append(r);
    return rows;
}

/* ================= 纯函数 ================= */

test('computeOrder: 已登记按保存序在前，未登记稳定追加末尾', () => {
    assert.deepEqual(SO.computeOrder(['a', 'b', 'c', 'd'], ['c', 'a'], false), ['c', 'a', 'b', 'd']);
});

test('computeOrder: unknownFirst=true 未登记的新 id 置顶且保持原相对顺序', () => {
    assert.deepEqual(SO.computeOrder(['a', 'b', 'c', 'd'], ['c', 'a'], true), ['b', 'd', 'c', 'a']);
});

test('computeOrder: saved 里已消失的 id 自然忽略，无需迁移', () => {
    assert.deepEqual(SO.computeOrder(['a', 'b'], ['gone', 'b', 'also-gone'], false), ['b', 'a']);
});

test('computeOrder: saved 为空 / null / 重复登记都退化为原序', () => {
    const ids = ['a', 'b', 'c'];
    assert.deepEqual(SO.computeOrder(ids, null, false), ids);
    assert.deepEqual(SO.computeOrder(ids, [], true), ids);
    assert.deepEqual(SO.computeOrder(ids, ['b', 'b'], false), ['b', 'a', 'c']);
    assert.notEqual(SO.computeOrder(ids, [], false), ids); // 返回副本，不改入参
});

test('move: 移到目标之前 / 之后 / 自己拖自己 / 目标不存在 / 源不存在', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.deepEqual(SO.move(ids, 'a', 'c', false), ['b', 'a', 'c', 'd']);   // 插到 c 之前
    assert.deepEqual(SO.move(ids, 'a', 'c', true), ['b', 'c', 'a', 'd']);    // 插到 c 之后
    assert.deepEqual(SO.move(ids, 'a', 'd', true), ['b', 'c', 'd', 'a']);
    assert.deepEqual(SO.move(ids, 'b', 'b', false), ids);
    assert.deepEqual(SO.move(ids, 'a', 'zzz', false), ['b', 'c', 'd', 'a']);
    assert.deepEqual(SO.move(ids, 'zzz', 'a', false), ids);
    assert.deepEqual(ids, ['a', 'b', 'c', 'd']); // 不改入参
});

test('sortBySaved: 无保存记录时原数组引用原样返回', () => {
    SO.setStorage(memoryStorage());
    const items = [{ id: 'a' }, { id: 'b' }];
    assert.equal(SO.sortBySaved(items, 'k', (x) => x.id), items);
});

test('sortBySaved: 按 idOf 排序，重复 id 保持桶内顺序', () => {
    SO.setStorage(memoryStorage());
    SO.saveContainer('k', ['b', 'a']);
    const items = [{ id: 'a', n: 1 }, { id: 'c', n: 2 }, { id: 'b', n: 3 }, { id: 'a', n: 4 }];
    const out = SO.sortBySaved(items, 'k', (x) => x.id, true);
    assert.deepEqual(out.map((x) => x.n), [2, 3, 1, 4]);
});

test('storage: 损坏 JSON / 非对象 / 数组 都安全退化为 {}', () => {
    SO.setStorage(memoryStorage());
    SO.setStorage({ getItem: () => '{oops', setItem: () => {} });
    assert.deepEqual(SO.read(), {});
    SO.setStorage({ getItem: () => '["a"]', setItem: () => {} });
    assert.deepEqual(SO.read(), {});
    SO.setStorage({ getItem: () => 'null', setItem: () => {} });
    assert.deepEqual(SO.read(), {});
});

test('readContainer: 脏数据（非字符串 / 空串 / 重复）清洗去重', () => {
    SO.setStorage(memoryStorage());
    SO.setStorage({
        getItem: () => JSON.stringify({ k: ['a', 3, '', 'a', null, 'b', {}] }),
        setItem: () => {}
    });
    assert.deepEqual(SO.readContainer('k'), ['a', 'b']);
    assert.equal(SO.readContainer('missing'), null);
});

test('saveContainer / clearContainer / clearAll / hasAny', () => {
    SO.setStorage(memoryStorage());
    assert.equal(SO.hasAny(), false);
    SO.saveContainer('k1', ['a', 'b']);
    SO.saveContainer('k2', ['c']);
    assert.equal(SO.hasAny(), true);
    assert.deepEqual(SO.readContainer('k1'), ['a', 'b']);
    SO.clearContainer('k1');
    assert.equal(SO.readContainer('k1'), null);
    assert.deepEqual(SO.readContainer('k2'), ['c']);
    SO.saveContainer('k2', []); // 空数组 = 删除该容器
    assert.equal(SO.hasAny(), false);
    SO.saveContainer('k3', ['x']);
    SO.clearAll();
    assert.equal(SO.hasAny(), false);
});

test('rowsOf / idsOf: 只收集【直属】且同类型的行', () => {
    const list = new El('div');
    const a = new El('div', { 'data-drag-type': 'session', 'data-drag-id': 'a' });
    a.append(new El('div', { 'data-drag-type': 'session', 'data-drag-id': 'nested' }));
    const b = new El('div', { 'data-drag-type': 'project', 'data-drag-id': 'b' });
    const c = new El('div', { 'data-drag-type': 'session', 'data-drag-id': 'c' });
    list.append(a, b, c);
    assert.deepEqual(SO.rowsOf(list, 'session'), [a, c]);
    assert.deepEqual(SO.idsOf(list, 'session'), ['a', 'c']);
    assert.deepEqual(SO.idsOf(list, 'project'), ['b']);
});

/* ================= 真实事件流 ================= */

test('bind: mousedown 手柄 → dragstart → dragover → drop 持久化新顺序并回调一次', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'sessions@__flat', ['a', 'b', 'c']);
    let calls = 0;
    SO.bind(list, () => { calls++; });

    dispatch(rows[0]._handle, 'mousedown');
    assert.equal(rows[0].getAttribute('draggable'), 'true');

    dispatch(rows[0], 'dragstart');
    rows[2].rect = { top: 100, height: 20 };
    const over = dispatch(rows[2], 'dragover', { clientY: 118 }); // 下半 → after
    assert.equal(over.defaultPrevented, true);
    assert.equal(over.dataTransfer.dropEffect, 'move');
    assert.ok(rows[2].classList.contains(SO.CLASS_AFTER));
    /* 回归：dragover 的 clearMarks 绝不能清掉源的 draggable（真实自审缺陷） */
    assert.equal(rows[0].getAttribute('draggable'), 'true');

    dispatch(rows[2], 'drop');
    assert.deepEqual(SO.readContainer('sessions@__flat'), ['b', 'c', 'a']);
    assert.equal(calls, 1);
    /* drop 收口：指示线类与 draggable 全部清掉 */
    assert.ok(!rows[2].classList.contains(SO.CLASS_AFTER));
    assert.equal(rows[0].getAttribute('draggable'), null);
});

test('bind: dragover 上半 → drop-before，插到目标之前', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b', 'c']);
    SO.bind(list, () => {});
    dispatch(rows[0]._handle, 'mousedown');
    dispatch(rows[0], 'dragstart');
    rows[2].rect = { top: 100, height: 20 };
    dispatch(rows[2], 'dragover', { clientY: 102 });
    assert.ok(rows[2].classList.contains(SO.CLASS_BEFORE));
    dispatch(rows[2], 'drop');
    assert.deepEqual(SO.readContainer('k'), ['b', 'a', 'c']);
});

test('bind: 未按住手柄（行无 draggable）时不接管拖拽', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b']);
    SO.bind(list, () => {});
    dispatch(rows[0], 'dragstart'); // 直接拖文本，没有 mousedown 加 draggable
    const over = dispatch(rows[1], 'dragover', { clientY: 15 });
    assert.equal(over.defaultPrevented, false);
    assert.ok(!rows[1].classList.contains(SO.CLASS_BEFORE));
    assert.ok(!rows[1].classList.contains(SO.CLASS_AFTER));
    dispatch(rows[1], 'drop');
    assert.equal(SO.readContainer('k'), null);
});

test('bind: 跨容器 / 跨类型不产生落点，drop 不写顺序', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const containerA = new El('div', { class: 'proj-sessions' });
    const containerB = new El('div', { class: 'proj-sessions' });
    list.append(containerA, containerB);
    const a = buildRows(containerA, 'session', 'sessions@A', ['a1', 'a2']);
    const b = buildRows(containerB, 'session', 'sessions@B', ['b1', 'b2']);
    SO.bind(list, () => {});
    dispatch(a[0]._handle, 'mousedown');
    dispatch(a[0], 'dragstart');
    const over = dispatch(b[0], 'dragover', { clientY: 15 });
    assert.equal(over.defaultPrevented, false); // 不同父 → 直接放行
    dispatch(b[0], 'drop');
    assert.equal(SO.readContainer('sessions@A'), null);
    assert.equal(SO.readContainer('sessions@B'), null);
});

test('bind: 拖到自己身上不保存、不触发重绘', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b']);
    let calls = 0;
    SO.bind(list, () => { calls++; });
    dispatch(rows[0]._handle, 'mousedown');
    dispatch(rows[0], 'dragstart');
    dispatch(rows[0], 'dragover', { clientY: 5 });
    assert.ok(!rows[0].classList.contains(SO.CLASS_BEFORE)); // 自己不加指示线
    dispatch(rows[0], 'drop');
    assert.equal(SO.readContainer('k'), null);
    assert.equal(calls, 0);
});

test('bind: dragend 收口所有临时状态，可连续再拖一次', () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b', 'c']);
    let calls = 0;
    SO.bind(list, () => { calls++; });
    dispatch(rows[0]._handle, 'mousedown');
    dispatch(rows[0], 'dragstart');
    dispatch(rows[1], 'dragover', { clientY: 15 });
    dispatch(list, 'dragend');
    assert.equal(rows[0].getAttribute('draggable'), null);
    assert.ok(!rows[0].classList.contains(SO.CLASS_DRAGGING));
    assert.ok(!rows[1].classList.contains(SO.CLASS_BEFORE));

    // 状态已复位：再拖一次仍然生效
    dispatch(rows[2]._handle, 'mousedown');
    dispatch(rows[2], 'dragstart');
    rows[0].rect = { top: 0, height: 20 };
    dispatch(rows[0], 'dragover', { clientY: 2 });
    dispatch(rows[0], 'drop');
    assert.deepEqual(SO.readContainer('k'), ['c', 'a', 'b']);
    assert.equal(calls, 1);
});

test('bind: document mouseup 兜底移除临时 draggable（拖到列表外松手）', () => {
    SO.setStorage(memoryStorage());
    const mouseups = [];
    const prevDoc = global.document;
    global.document = { addEventListener: (t, fn) => { if (t === 'mouseup') mouseups.push(fn); } };
    try {
        const list = new El('div');
        const rows = buildRows(list, 'session', 'k', ['a', 'b']);
        SO.bind(list, () => {});
        dispatch(rows[0]._handle, 'mousedown');
        assert.equal(rows[0].getAttribute('draggable'), 'true');
        assert.equal(mouseups.length, 1);
        for (const fn of mouseups) fn();
        assert.equal(rows[0].getAttribute('draggable'), null);
    } finally {
        if (prevDoc === undefined) delete global.document; else global.document = prevDoc;
    }
});

test('bind: 常量与宿主契约（类名 / 存储键 / 三类 data-drag 元数据）', () => {
    assert.equal(typeof SO.STORAGE_KEY, 'string');
    assert.equal(SO.CLASS_BEFORE, 'sidebar-drop-before');
    assert.equal(SO.CLASS_AFTER, 'sidebar-drop-after');
    assert.equal(SO.CLASS_DRAGGING, 'sidebar-dragging');
    assert.equal(typeof SO.bind, 'function');
});

/* ===== 自审回归（真实缺陷，不是假想场景）===== */

test('bind: dragstart 的 0ms 延迟类不会在 drop/reset 之后把行重新染灰', async () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b']);
    SO.bind(list, () => {});
    dispatch(rows[0]._handle, 'mousedown');
    dispatch(rows[0], 'dragstart');   // 排了一个 setTimeout(0)
    dispatch(rows[1], 'dragover', { clientY: 15 });
    dispatch(rows[1], 'drop');        // 同一 tick 内 reset：state.row = null
    /* 必须等 0ms 回调真正跑过才能断言：同步测试永远抓不到这个 bug。
       旧实现无守卫，回调里无条件 add(CLASS_DRAGGING)，结果「拖完行永久发灰」。 */
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!rows[0].classList.contains(SO.CLASS_DRAGGING));
    assert.equal(rows[0].getAttribute('draggable'), null);
});

test('bind: 正常拖拽时 0ms 回调仍会给正在拖的行加上 dragging 类', async () => {
    SO.setStorage(memoryStorage());
    const list = new El('div');
    const rows = buildRows(list, 'session', 'k', ['a', 'b']);
    SO.bind(list, () => {});
    dispatch(rows[0]._handle, 'mousedown');
    dispatch(rows[0], 'dragstart');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(rows[0].classList.contains(SO.CLASS_DRAGGING)); // 守卫不能误伤正常路径
    dispatch(list, 'dragend');
    assert.ok(!rows[0].classList.contains(SO.CLASS_DRAGGING));
});

test('CSS 纪律锁：不得用 [data-drag-type] 规则覆盖行原有的 cursor:pointer', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const css = fs.readFileSync(path.join(__dirname, '../ui/css/app.css'), 'utf8');
    /* 行本身是 cursor:pointer；末尾追加同特异性 [data-drag-type]{cursor:...} 会把
       可点击手型冲掉，破坏「不拖时默认展示逐字不变」。拖拽反馈只由手柄 grab 承担。 */
    assert.doesNotMatch(css, /\[data-drag-type\]\s*\{[^}]*cursor\s*:/,
        '不要给 [data-drag-type] 设 cursor：会覆盖 .sidebar-item/.proj-node 的 pointer');
    /* 指示线必须是伪元素，绝不能往 DOM 插指示线兄弟节点（相邻兄弟选择器会静默失效） */
    assert.match(css, /\.sidebar-drop-before::before/);
    assert.match(css, /\.sidebar-drop-after::after/);
    const js = fs.readFileSync(path.join(__dirname, '../ui/js/app-sidebar-order.js'), 'utf8');
    assert.doesNotMatch(js, /insertBefore|appendChild|createElement/);
});

test('CSS 纪律锁：手柄有 grab 光标且不破坏既有悬停操作组的显隐契约', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const css = fs.readFileSync(path.join(__dirname, '../ui/css/app.css'), 'utf8');
    assert.match(css, /\.sidebar-drag-handle\s*\{[^}]*cursor:\s*grab/s);
    assert.match(css, /\.sidebar-drag-handle:active\s*\{[^}]*cursor:\s*grabbing/s);
    assert.match(css, /\.sidebar-dragging\s*\{\s*opacity:/);
});
