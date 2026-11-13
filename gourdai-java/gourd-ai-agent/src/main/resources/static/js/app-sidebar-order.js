/* ===== app-sidebar-order.js ===== */
/* 左侧栏「任务 / 项目空间 / 分组」自定义拖动排序。
 *
 * 分层（与 app-model-settings.js 的 LS_PROVIDER_ORDER 同一范式）：
 *   1) 纯顺序层：localStorage 覆盖层，只影响本机展示顺序；不改后端 projects.json
 *      （那份数组语义是「最近使用置顶」，Rust/Java 双内核共享且 Java 会丢弃未知字段），
 *      也不改会话元数据（wire shape 里根本没有可写 order 字段）。
 *   2) DnD 绑定层：HTML5 原生拖拽，按住行内手柄才 draggable，不干扰点击/展开/折叠。
 *
 * 四类可拖对象，各自只在【同一容器】内排序（不跨容器 = 不做数据迁移）：
 *   - group    容器 #historyList 直属 .ws-group          key = 'groups'
 *   - project  容器 .ws-group-body 内 .proj-node         key = 'projects@<scopeKey>'
 *   - session  容器 .proj-sessions / .ws-group-global-body / #historyList（对话 tab / code 平铺）
 *                                                        key = 'sessions@<projectKey>' 等
 *
 * 存储：gourdai-sidebar-order → { "<containerKey>": ["<id>", ...] }
 *   只存用户拖过的容器；没记录的容器保持原有默认排序（执行中置顶 + 时间倒序）。
 *   读取时已消失的 id 自然忽略，新 id 稳定追加到末尾，无需迁移逻辑。
 *
 * 【关键纪律 · 指示线不插 DOM】落点指示线用 ::before/::after 伪元素画在行自身，
 * 绝不往 DOM 插入「指示线 div」兄弟节点：.proj-node.expanded + .proj-sessions
 * 是相邻兄弟选择器，插任何兄弟都会让展开态静默失效；.ws-group 头/体之间同理
 * （历史上 .ws-group-acts 插节点已让 .ws-group-head + .ws-group-body 整体失灵一次）。
 *
 * UMD：浏览器挂 window.GourdSidebarOrder；node:test 直接 require 测纯函数。
 */
(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.GourdSidebarOrder = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
    'use strict';

    var STORAGE_KEY = 'gourdai-sidebar-order';
    var CLASS_BEFORE = 'sidebar-drop-before';
    var CLASS_AFTER = 'sidebar-drop-after';
    var CLASS_DRAGGING = 'sidebar-dragging';

    /* 测试可注入内存 storage，避免依赖浏览器全局 */
    var _storage = null;
    function storage() {
        if (_storage) return _storage;
        try { return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null; }
        catch (e) { return null; }
    }
    function setStorage(s) { _storage = s; }

    function read() {
        var s = storage();
        if (!s) return {};
        try {
            var v = JSON.parse(s.getItem(STORAGE_KEY) || '{}');
            return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
        } catch (e) { return {}; }
    }
    function write(map) {
        var s = storage();
        if (!s) return;
        try { s.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (e) {}
    }

    /* 读单容器顺序；去重 + 只保留字符串，脏数据不污染排序 */
    function readContainer(key) {
        var arr = read()[key];
        if (!Array.isArray(arr)) return null;
        var out = [], seen = {}, i, id;
        for (i = 0; i < arr.length; i++) {
            id = arr[i];
            if (typeof id !== 'string' || !id || Object.prototype.hasOwnProperty.call(seen, id)) continue;
            seen[id] = 1;
            out.push(id);
        }
        return out;
    }
    function saveContainer(key, ids) {
        var map = read();
        if (!ids || !ids.length) delete map[key];
        else map[key] = ids;
        write(map);
    }
    function clearContainer(key) { var map = read(); delete map[key]; write(map); }
    function clearAll() { write({}); }
    function hasAny() {
        var map = read(), k;
        for (k in map) if (Object.prototype.hasOwnProperty.call(map, k)) return true;
        return false;
    }

    /* 纯计算：saved 中登记的 id 按登记序在前；未登记的新 id 按当前原序稳定追加末尾。
       saved 里已消失的 id 不出现在结果里，天然无需清理。
       unknownFirst=true：未登记的新 id 排到前面（会话/项目用——新对话、新登记的项目
       仍应出现在顶部，符合「最近使用置顶」的既有语义），已拖过的条目保持彼此相对顺序。 */
    function computeOrder(ids, saved, unknownFirst) {
        var current = (ids || []).slice();
        if (!saved || !saved.length) return current;
        var rank = {}, i;
        for (i = 0; i < saved.length; i++) rank[saved[i]] = i;
        var known = [], unknown = [];
        for (i = 0; i < current.length; i++) {
            if (Object.prototype.hasOwnProperty.call(rank, current[i])) known.push(current[i]);
            else unknown.push(current[i]);
        }
        known.sort(function (a, b) { return rank[a] - rank[b]; });
        return unknownFirst ? unknown.concat(known) : known.concat(unknown);
    }

    /* 给任意 items 数组排序。idOf(item) → 稳定 id。
       没有保存记录时原数组原样返回（连引用都不换，避免无谓重排）。 */
    function sortBySaved(items, key, idOf, unknownFirst) {
        var saved = readContainer(key);
        if (!saved || !saved.length || !items || !items.length) return items;
        var uniqueIds = [], byId = {}, i, j, id;
        for (i = 0; i < items.length; i++) {
            id = String(idOf(items[i]));
            if (!Object.prototype.hasOwnProperty.call(byId, id)) {
                byId[id] = [];
                uniqueIds.push(id);
            }
            byId[id].push(items[i]);
        }
        var order = computeOrder(uniqueIds, saved, unknownFirst);
        var out = [];
        for (i = 0; i < order.length; i++) {
            var bucket = byId[order[i]];
            if (!bucket) continue;
            for (j = 0; j < bucket.length; j++) out.push(bucket[j]);
        }
        return out;
    }

    /* 纯计算：把 fromId 移到 toId 之前/之后。找不到目标则落到末尾，自己拖自己原样返回。 */
    function move(ids, fromId, toId, after) {
        var arr = (ids || []).slice();
        var from = arr.indexOf(fromId);
        if (from < 0 || fromId === toId) return arr;
        arr.splice(from, 1);
        var to = arr.indexOf(toId);
        if (to < 0) { arr.push(fromId); return arr; }
        arr.splice(after ? to + 1 : to, 0, fromId);
        return arr;
    }

    /* ===== DOM 辅助（只需 Element 的最小子集，便于用轻量桩做真实事件测试）===== */
    function attr(el, name) { return el && el.getAttribute ? el.getAttribute(name) : null; }
    function rowsOf(parent, type) {
        var out = [], kids = parent && parent.children ? parent.children : [];
        for (var i = 0; i < kids.length; i++) {
            if (attr(kids[i], 'data-drag-type') === type) out.push(kids[i]);
        }
        return out;
    }
    function idsOf(parent, type) {
        var rows = rowsOf(parent, type), out = [];
        for (var i = 0; i < rows.length; i++) out.push(attr(rows[i], 'data-drag-id'));
        return out;
    }
    function clearMarks(list) {
        if (!list || !list.querySelectorAll) return;
        /* 只清落点指示线：绝不能在这里移除 [draggable] / .sidebar-dragging。
           dragover 每几十毫秒触发一次，而 draggable 是 mousedown 时给「正在拖的行」加的，
           一旦被清掉，后续 drop 仍在但拖拽视觉与语义都会错乱（真实自审缺陷）。
           draggable / dragging 统一由 dragend + mouseup 收口。 */
        var all = list.querySelectorAll('.' + CLASS_BEFORE + ', .' + CLASS_AFTER);
        for (var i = 0; i < all.length; i++) {
            if (all[i].classList) all[i].classList.remove(CLASS_BEFORE, CLASS_AFTER);
        }
    }
    function clearDragState(list) {
        if (!list || !list.querySelectorAll) return;
        clearMarks(list);
        var all = list.querySelectorAll('.' + CLASS_DRAGGING + ', [draggable]');
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.classList) el.classList.remove(CLASS_DRAGGING);
            if (el.removeAttribute) el.removeAttribute('draggable');
        }
    }

    /* 绑定 #historyList 的拖放事件。onChanged() 在落点持久化后调用（宿主负责重绘）。 */
    function bind(list, onChanged) {
        if (!list || !list.addEventListener) return;
        var state = { type: null, key: null, id: null, row: null, parent: null, target: null, after: false };

        function reset() {
            clearDragState(list);
            state.type = null; state.key = null; state.id = null; state.row = null;
            state.parent = null; state.target = null; state.after = false;
        }

        /* 只有按住手柄才给行加 draggable：整行仍可点击选中/展开/折叠。
           绝不能 preventDefault —— 取消 mousedown 默认行为会阻止浏览器发起 HTML5 拖拽。 */
        list.addEventListener('mousedown', function (e) {
            var t = e.target;
            var handle = t && t.closest ? t.closest('.sidebar-drag-handle') : null;
            if (!handle) return;
            var row = handle.closest ? handle.closest('[data-drag-type]') : null;
            if (row && row.setAttribute) row.setAttribute('draggable', 'true');
        });
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('mouseup', function () {
                if (!list.querySelectorAll) return;
                var els = list.querySelectorAll('[draggable]');
                for (var i = 0; i < els.length; i++) {
                    if (els[i].removeAttribute) els[i].removeAttribute('draggable');
                }
            });
        }

        list.addEventListener('dragstart', function (e) {
            var t = e.target;
            var row = t && t.closest ? t.closest('[data-drag-type]') : null;
            /* 没有 draggable = 用户拖的是行内选中的文本：直接放行原生行为，不接管、不 preventDefault。 */
            if (!row || !row.hasAttribute || !row.hasAttribute('draggable')) return;
            state.type = attr(row, 'data-drag-type');
            state.key = attr(row, 'data-drag-key');
            state.id = attr(row, 'data-drag-id');
            state.parent = row.parentNode;
            state.row = row;
            state.target = null;
            state.after = false;
            var dt = e.dataTransfer;
            if (dt) {
                try { dt.effectAllowed = 'move'; dt.setData('text/plain', state.id); } catch (err) {}
                /* 拖分组时整组（含所有展开的项目/会话）拖影过大：把快照缩成组头一行。 */
                try {
                    var head = (state.type === 'group' && row.querySelector) ? (row.querySelector('.ws-group-head') || row) : row;
                    if (dt.setDragImage) dt.setDragImage(head, 12, 12);
                } catch (err) {}
            }
            /* 延迟加类，保证拖拽快照是正常外观。
               守卫：这 0ms 内若已 drop / dragend（快速拖放、或拖到列表外松手），
               reset 已把 state.row 清空并收口掉 .sidebar-dragging —— 此时绝不能再把
               半透明类加回一个已经不处于拖拽态的行（否则表现为「拖完后行永久发灰」）。 */
            var dragged = row;
            setTimeout(function () {
                if (state.row === dragged && dragged.classList) dragged.classList.add(CLASS_DRAGGING);
            }, 0);
        });

        list.addEventListener('dragover', function (e) {
            if (!state.type) return;
            var t = e.target;
            var target = t && t.closest ? t.closest('[data-drag-type]') : null;
            /* 同父 + 同类型 = 同一容器：天然禁止跨分组/跨项目/跨 tab 移动 */
            if (!target || target.parentNode !== state.parent || attr(target, 'data-drag-type') !== state.type) return;
            if (e.preventDefault) e.preventDefault();
            if (e.dataTransfer) { try { e.dataTransfer.dropEffect = 'move'; } catch (err) {} }
            var rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { top: 0, height: 0 };
            var after = (e.clientY - rect.top) > rect.height / 2;
            clearMarks(list);
            state.target = target;
            state.after = after;
            if (target !== state.row && target.classList) {
                target.classList.add(after ? CLASS_AFTER : CLASS_BEFORE);
            }
        });

        list.addEventListener('drop', function (e) {
            if (!state.type) return;
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            var type = state.type, key = state.key, fromId = state.id,
                parent = state.parent, target = state.target, after = state.after,
                isSelf = !target || target === state.row;
            var toId = target ? attr(target, 'data-drag-id') : null;
            reset();
            if (isSelf || !toId || !key) return;
            var ids = idsOf(parent, type);
            var next = move(ids, fromId, toId, after);
            saveContainer(key, next);
            if (onChanged) onChanged();
        });

        list.addEventListener('dragend', reset);
        return { reset: reset, state: state };
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        CLASS_BEFORE: CLASS_BEFORE,
        CLASS_AFTER: CLASS_AFTER,
        CLASS_DRAGGING: CLASS_DRAGGING,
        setStorage: setStorage,
        read: read,
        readContainer: readContainer,
        saveContainer: saveContainer,
        clearContainer: clearContainer,
        clearAll: clearAll,
        hasAny: hasAny,
        computeOrder: computeOrder,
        sortBySaved: sortBySaved,
        move: move,
        idsOf: idsOf,
        rowsOf: rowsOf,
        bind: bind
    };
});
