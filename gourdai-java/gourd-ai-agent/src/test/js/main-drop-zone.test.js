/**
 * 主内容区拖放落区 —— 行为级测试。
 *
 * 覆盖本轮修复的三个真实缺陷（均由真浏览器探针实测抓出，非推测）：
 *  1. types 大小写：Chrome 对 OS 文件拖放给 'Files'，但 setData('Files') 实测归一为
 *     'files'，HTML 规范也要求小写。严格比较 'Files' 会在小写实现上整体失效
 *     （连 document 导航护栏一起失效 → 又会导航到 file://）。
 *  2. 既有落区在 dragover/drop 上无条件 preventDefault，会杀死 textarea 内
 *     「拖选中文本→拖到光标处」的原生能力（实测 types 仅 ['text/plain'] 时
 *     defaultPrevented 仍为 true）。
 *  3. 落区仅占视口 8.25%（只有两个输入框），拖到消息区/侧栏/空白处静默无反应。
 *
 * 测试方式：把真实源码切片放进 vm 沙箱，配 jQuery/DOM 桩，直接触发已注册的 handler
 * 观测行为。不用正则断言——同仓 attachment-and-submit-contract.test.js 的变异验证
 * 实测显示，正则测试对「只收 image/*」这类核心缺陷 8 个变异只杀死 1 个。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_UI = path.resolve(__dirname, '../../main/resources/static/js/app-ui.js');
const SRC = fs.readFileSync(APP_UI, 'utf8');

/** 按花括号配对切出顶层/嵌套函数（签名唯一即可）。 */
function sliceFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `未找到函数：${signature}`);
    let i = source.indexOf('{', start);
    assert.ok(i >= 0, `函数 ${signature} 缺少函数体`);
    let depth = 0;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return source.slice(start, i + 1);
}

/** 按首尾标记切片（用于 IIFE 尾部的绑定语句段）。 */
function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记：${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记：${endMarker}`);
    return source.slice(start, end + endMarker.length);
}

const FN_DRAG_CARRIES = sliceFunction(SRC, 'function dragCarriesFiles(');
const FN_IS_MAIN_TARGET = sliceFunction(SRC, 'function isMainAreaDropTarget(');
const FN_ACCEPT = sliceFunction(SRC, 'function acceptDroppedFiles(');
const FN_FILES_OF = sliceFunction(SRC, 'function filesOf(');
const FN_HANDLE_DROP = sliceFunction(SRC, 'function handleDrop(');
const FN_BIND_ZONE = sliceFunction(SRC, 'function bindDropZone(');
/**
 * 完整切出「Drag & Drop File Upload」IIFE。
 *
 * 必须从 `(function() {` 起切：尾段依赖 IIFE prologue 里的
 * `var welcomeDropZone = $('#welcomeDropZone')` 等变量，只切尾部会拿到
 * undefined（实测报 `zone.on is not a function`）。
 */
const IIFE_ANCHOR = "var welcomeDropZone = $('#welcomeDropZone');";
const IIFE_ANCHOR_IDX = SRC.indexOf(IIFE_ANCHOR);
assert.ok(IIFE_ANCHOR_IDX > 0, '未找到拖放 IIFE 的 prologue 锚点');
const IIFE_START_IDX = SRC.lastIndexOf('(function() {', IIFE_ANCHOR_IDX);
assert.ok(IIFE_START_IDX > 0, '未找到拖放 IIFE 的 (function() { 开头');
const IIFE_END_MARK = '})();';
const IIFE_END_IDX = SRC.indexOf(IIFE_END_MARK, IIFE_ANCHOR_IDX);
assert.ok(IIFE_END_IDX > IIFE_START_IDX, '未找到拖放 IIFE 的结尾');
const DROP_IIFE = SRC.slice(IIFE_START_IDX, IIFE_END_IDX + IIFE_END_MARK.length);

// 自检：切片必须含主内容区绑定与 document 导航护栏，且语法可解析
test('沙箱切片可被解析（防止脚手架自身制造假失败）', () => {
    for (const [name, code] of [
        ['dragCarriesFiles', FN_DRAG_CARRIES],
        ['isMainAreaDropTarget', FN_IS_MAIN_TARGET],
        ['acceptDroppedFiles', FN_ACCEPT],
        ['filesOf', FN_FILES_OF],
        ['handleDrop', FN_HANDLE_DROP],
        ['bindDropZone', FN_BIND_ZONE],
        ['DROP_IIFE', DROP_IIFE],
    ]) {
        assert.doesNotThrow(() => new vm.Script(code), `${name} 切片语法错误：脚手架失效`);
    }
    assert.ok(DROP_IIFE.startsWith('(function() {'), 'IIFE 切片应以 (function() { 开头');
    assert.ok(DROP_IIFE.endsWith('})();'), 'IIFE 切片应以 })(); 结尾');
    assert.ok(DROP_IIFE.includes(IIFE_ANCHOR), 'IIFE 切片应包含 prologue 变量声明');
    assert.ok(DROP_IIFE.includes("$('.main-area')"), '应包含主内容区绑定');
    assert.ok(DROP_IIFE.includes('dropguard'), '应包含 document 导航护栏');
});

// ── jQuery / DOM 桩 ─────────────────────────────────────────────

/**
 * jQuery 桩：记录每个选择器的 (event, handler) 绑定，供测试手动触发。
 * 支持 'dragover.dropguard drop.dropguard' 这种带命名空间的多事件写法。
 * opts.emptySelectors：让 $(sel) 返回 length 为 0（模拟元素不存在）。
 */
function makeJqStub(opts = {}) {
    const bindings = [];   // { target, event, ns, handler }
    const overlays = {};   // key -> Set of classes
    const empty = new Set(opts.emptySelectors || []);

    function ensure(key) {
        if (!overlays[key]) overlays[key] = new Set();
        return overlays[key];
    }

    function $(arg) {
        const key = String(arg && arg.__stubKey ? arg.__stubKey : arg);
        const api = {
            length: empty.has(key) ? 0 : 1,
            on(events, handler) {
                String(events).split(/\s+/).filter(Boolean).forEach(ev => {
                    const [event, ns] = ev.split('.');
                    bindings.push({ target: key, event, ns: ns || '', raw: ev, handler });
                });
                return api;
            },
            addClass(c) { ensure(key).add(c); return api; },
            removeClass(c) { ensure(key).delete(c); return api; },
            hasClass(c) { return ensure(key).has(c); },
        };
        return api;
    }
    $.__bindings = bindings;
    $.__classes = overlays;
    /** 取出某目标某事件的全部 handler */
    $.handlersFor = (target, event) =>
        bindings.filter(b => b.target === target && b.event === event).map(b => b.handler);
    return $;
}

/** elementFromPoint 风格的最小 DOM 桩：带 closest() 祖先链。 */
function fakeEl(tag, ancestors = [], id = '') {
    const chain = [{ tagName: tag, id, className: '' }, ...ancestors];
    return {
        tagName: tag, id, className: '',
        closest(sel) {
            // 支持 '.a, .b' 逗号分组（生产代码正是这种写法）
            const wanted = String(sel).split(',').map(s => s.trim()).filter(Boolean);
            for (const node of chain) {
                const cls = (node.className || '').split(/\s+/).filter(Boolean).map(c => '.' + c);
                const idSel = node.id ? '#' + node.id : null;
                for (const w of wanted) {
                    if (cls.includes(w) || (idSel && idSel === w) ||
                        (w === node.tagName) || (w === node.tagName.toLowerCase())) return node;
                }
            }
            return null;
        },
    };
}

/** DataTransfer 桩：types 可指定大小写（缺陷1 的关键）。 */
function fakeEvent({ types = ['Files'], files = [], target = null, dtTypes = 'dataTransfer' } = {}) {
    const ev = {
        target,
        _prevented: false,
        _stopped: false,
        preventDefault() { this._prevented = true; },
        stopPropagation() { this._stopped = true; },
    };
    ev[dtTypes] = {
        types,
        files,
        get items() { return []; },
    };
    return ev;
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function fakeFile(name, type) { return { name, type, size: 8 }; }

/**
 * 遮罩是否处于点亮态。
 *
 * __classes 里的类集是懒创建的：handler 若因门禁直接 return，从未调用
 * addClass/removeClass，对应键就不存在。键不存在 ≡ 遮罩从未被碰过 ≡ 未点亮，
 * 不能直接 .has() 否则报 TypeError（脚手架曾因此假报 2 个失败）。
 */
function overlayActive(sb, key) {
    const set = sb.__$.__classes[key];
    return set ? set.has('active') : false;
}

/**
 * 建沙箱。图片走「异步 push」桩以还原真实语义（FileReader.onload 里才 push），
 * 这样名额守卫若退化成只看 pendingFiles.length，多图场景就会超限 → 可被变异杀死。
 */
function makeSandbox(opts = {}) {
    const pendingFiles = [];
    const pendingAsync = [];   // 模拟 FileReader 尚未回调的图片
    const toasts = [];
    // .main-area 缺失场景：让 $('.main-area') 返回 length 0，验证守卫分支
    const $ = makeJqStub({ emptySelectors: opts.mainAreaMissing ? ['.main-area'] : [] });

    const sandbox = {
        pendingFiles,
        MAX_ATTACHMENTS: opts.max ?? 10,
        showToast: (msg, kind) => toasts.push({ msg, kind }),
        GourdI18n: { t: (k, ...a) => k },
        // 真实 processSelectedFile：图片走 FileReader 异步 push，非图片同步 push
        processSelectedFile(file, type) {
            if (pendingFiles.length >= sandbox.MAX_ATTACHMENTS) return;
            if (type === 'image') { pendingAsync.push({ type: 'image', name: file.name, attachmentsType: 'image' }); return; }
            pendingFiles.push({ type: 'file', name: file.name, attachmentsType: 'file' });
        },
        $,
        document: { __stubKey: 'document' },
        console, Math, JSON, String, Number, Array, Object, Promise, Uint8Array,
        __toasts: toasts, __pendingAsync: pendingAsync, __$: $,
        // handler 的 this 占位：drag/drop 处理器全部读闭包变量与 e，不读 this，
        // 而落区/遮罩桩已随 prologue 移入 IIFE 闭包，Node 侧不再持有引用。
        __self: {},
    };

    vm.createContext(sandbox);
    /* 整体执行真实源码：
       - 两个顶层函数（dragCarriesFiles / isMainAreaDropTarget）供直接调用断言；
       - 完整 IIFE 自己跑 prologue（`var welcomeDropZone = $('#welcomeDropZone')` 等）
         并完成全部绑定 —— 这些变量与 acceptDroppedFiles/handleDrop/bindDropZone
         都活在 IIFE 闭包里，分散切片必然拿到 undefined（实测报 zone.on is not a function）。
       闭包内的 mainDragCounter 无法直接读取，计数器归零改由遮罩类的可观测行为断言。 */
    new vm.Script([
        FN_DRAG_CARRIES,
        FN_IS_MAIN_TARGET,
        DROP_IIFE,
    ].join('\n\n')).runInContext(sandbox);

    return sandbox;
}

// ══════════════════════════════════════════════════════════════
// 缺陷1：types 大小写兼容
// ══════════════════════════════════════════════════════════════

test('dragCarriesFiles 识别大写 Files（Chrome OS 文件拖放的实际取值）', () => {
    const sb = makeSandbox();
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['Files'] })), true);
});

test('dragCarriesFiles 识别小写 files（setData 归一 / HTML 规范要求的小写形态）', () => {
    const sb = makeSandbox();
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['files'] })), true,
        '严格比较 "Files" 会在小写实现上整体失效，连导航护栏一起失效');
});

test('dragCarriesFiles 对混合 types（files + text/plain）仍判为携带文件', () => {
    const sb = makeSandbox();
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['text/plain', 'files'] })), true);
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['Files', 'text/uri-list'] })), true);
});

test('dragCarriesFiles 对纯文本拖放判为 false（不得劫持文本拖放）', () => {
    const sb = makeSandbox();
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['text/plain'] })), false);
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: ['text/uri-list'] })), false);
    assert.strictEqual(sb.dragCarriesFiles(fakeEvent({ types: [] })), false);
});

test('dragCarriesFiles 对 dataTransfer 缺失/types 缺失不抛异常', () => {
    const sb = makeSandbox();
    assert.doesNotThrow(() => sb.dragCarriesFiles({}));
    assert.strictEqual(sb.dragCarriesFiles({}), false);
    assert.strictEqual(sb.dragCarriesFiles({ dataTransfer: {} }), false);
    // jQuery 包装形态：只有 originalEvent
    assert.strictEqual(sb.dragCarriesFiles({ originalEvent: { dataTransfer: { types: ['Files'] } } }), true);
});

// ══════════════════════════════════════════════════════════════
// 缺陷3：主内容区落区判定与 Monaco 排除
// ══════════════════════════════════════════════════════════════

test('isMainAreaDropTarget 接受 .main-area 内的普通目标', () => {
    const sb = makeSandbox();
    const el = fakeEl('DIV', [{ tagName: 'DIV', className: 'welcome-view' }, { tagName: 'DIV', className: 'main-area' }]);
    assert.strictEqual(sb.isMainAreaDropTarget(el), true);
});

test('isMainAreaDropTarget 排除 Monaco 编辑器（保留「拖文件进编辑器=插入路径」语义）', () => {
    const sb = makeSandbox();
    const inMonaco = fakeEl('DIV', [
        { tagName: 'DIV', className: 'monaco-editor' },
        { tagName: 'DIV', className: 'code-editor-host' },
        { tagName: 'DIV', className: 'code-editor-col' },
        { tagName: 'DIV', className: 'main-area' },
    ]);
    assert.strictEqual(sb.isMainAreaDropTarget(inMonaco), false, 'Monaco 内不得被主落区接管');

    const inEditorCol = fakeEl('DIV', [
        { tagName: 'DIV', className: 'code-editor-pane' },
        { tagName: 'DIV', className: 'code-editor-col' },
        { tagName: 'DIV', className: 'main-area' },
    ]);
    assert.strictEqual(sb.isMainAreaDropTarget(inEditorCol), false, 'code 编辑器整列都排除');
});

test('isMainAreaDropTarget 拒绝 .main-area 之外的目标（侧栏/文件树/设置浮层）', () => {
    const sb = makeSandbox();
    // 侧栏：body 级，不在 main-area 内
    const sidebar = fakeEl('DIV', [{ tagName: 'DIV', className: 'sidebar' }, { tagName: 'BODY' }]);
    assert.strictEqual(sb.isMainAreaDropTarget(sidebar), false);
    // 文件树面板：body 级
    const filer = fakeEl('DIV', [{ tagName: 'DIV', className: 'filer-panel' }, { tagName: 'BODY' }]);
    assert.strictEqual(sb.isMainAreaDropTarget(filer), false);
    // 设置浮层：body 级
    const settings = fakeEl('DIV', [{ tagName: 'DIV', className: 'settings-overlay' }, { tagName: 'BODY' }]);
    assert.strictEqual(sb.isMainAreaDropTarget(settings), false);
});

test('isMainAreaDropTarget 对 null / 无 closest 的目标安全返回 false', () => {
    const sb = makeSandbox();
    assert.strictEqual(sb.isMainAreaDropTarget(null), false);
    assert.strictEqual(sb.isMainAreaDropTarget(undefined), false);
    assert.strictEqual(sb.isMainAreaDropTarget({}), false);
    assert.strictEqual(sb.isMainAreaDropTarget('text-node'), false);
});

// ══════════════════════════════════════════════════════════════
// 缺陷2：既有落区不得劫持文本拖放
// ══════════════════════════════════════════════════════════════

test('输入框落区的 dragover 对纯文本拖放不 preventDefault（保住原生文本拖放）', () => {
    const sb = makeSandbox();
    const handlers = sb.__$.handlersFor('#welcomeDropZone', 'dragover');
    assert.strictEqual(handlers.length, 1, 'dragover 应已注册');
    const ev = fakeEvent({ types: ['text/plain'], target: fakeEl('TEXTAREA') });
    handlers[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, false,
        '无条件 preventDefault 会杀死 textarea 内「拖选中文本→拖到光标处」的原生能力');
    assert.strictEqual(ev._stopped, false);
});

test('输入框落区的 drop 对纯文本拖放不 preventDefault', () => {
    const sb = makeSandbox();
    const handlers = sb.__$.handlersFor('#welcomeDropZone', 'drop');
    const ev = fakeEvent({ types: ['text/plain'], files: [], target: fakeEl('TEXTAREA') });
    handlers[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, false, '文本 drop 应交给浏览器原生处理');
    assert.strictEqual(sb.pendingFiles.length, 0, '文本 drop 不得产生附件');
});

test('输入框落区的 dragenter/dragleave 对纯文本拖放不动遮罩', () => {
    const sb = makeSandbox();
    const enter = sb.__$.handlersFor('#welcomeDropZone', 'dragenter');
    const leave = sb.__$.handlersFor('#welcomeDropZone', 'dragleave');
    const ev1 = fakeEvent({ types: ['text/plain'], target: fakeEl('TEXTAREA') });
    enter[0].call(sb.__self, ev1);
    // 遮罩类集是懒创建的：文本拖放下 handler 直接 return，从未碰过 addClass/removeClass，
    // 故 __classes 里没有该键。键不存在 ≡ 遮罩从未被动过 ≡ 未点亮。
    assert.strictEqual(overlayActive(sb, '#welcomeDropOverlay'), false,
        '文本拖放不得点亮文件落区遮罩（视觉误导）');
    const ev2 = fakeEvent({ types: ['text/plain'], target: fakeEl('TEXTAREA') });
    leave[0].call(sb.__self, ev2);
    assert.strictEqual(ev2._prevented, false);
    assert.strictEqual(overlayActive(sb, '#welcomeDropOverlay'), false);
});

test('输入框落区对携带文件的拖放仍正常接管（不得因新增门禁而回归）', () => {
    const sb = makeSandbox();
    const ev = fakeEvent({ types: ['Files'], files: [fakeFile('a.xlsx', XLSX)], target: fakeEl('TEXTAREA') });
    sb.__$.handlersFor('#welcomeDropZone', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, true);
    assert.strictEqual(ev._stopped, true, '须 stopPropagation，避免主落区重复受理');
    assert.strictEqual(sb.pendingFiles.length, 1);
    assert.strictEqual(sb.pendingFiles[0].attachmentsType, 'file');
});

// ══════════════════════════════════════════════════════════════
// 主内容区落区：绑定与行为
// ══════════════════════════════════════════════════════════════

test('主内容区已绑定 dragenter/dragover/dragleave/drop 四个事件', () => {
    const sb = makeSandbox();
    for (const ev of ['dragenter', 'dragover', 'dragleave', 'drop']) {
        assert.ok(sb.__$.handlersFor('.main-area', ev).length >= 1, `.main-area 应绑定 ${ev}`);
    }
});

test('拖文件到主内容区中部（原落区外）：受理为附件', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'welcome-view' }, { tagName: 'DIV', className: 'main-area' }]);
    const ev = fakeEvent({ types: ['Files'], files: [fakeFile('report.xlsx', XLSX)], target });
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, true, '主内容区应接管文件拖放');
    assert.strictEqual(sb.pendingFiles.length, 1);
    assert.strictEqual(sb.pendingFiles[0].attachmentsType, 'file');
});

test('拖图片到主内容区：走 image 路径', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'chat-view' }, { tagName: 'DIV', className: 'main-area' }]);
    const ev = fakeEvent({ types: ['Files'], files: [fakeFile('shot.png', 'image/png')], target });
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, true);
    assert.strictEqual(sb.__pendingAsync.length, 1, '图片应进入异步（FileReader）分支');
    assert.strictEqual(sb.__pendingAsync[0].attachmentsType, 'image');
});

test('拖到 Monaco 编辑器区：主落区不受理（交给编辑器自身语义）', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [
        { tagName: 'DIV', className: 'monaco-editor' },
        { tagName: 'DIV', className: 'code-editor-col' },
        { tagName: 'DIV', className: 'main-area' },
    ]);
    const ev = fakeEvent({ types: ['Files'], files: [fakeFile('a.xlsx', XLSX)], target });
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, false, 'Monaco 区不得被主落区 preventDefault');
    assert.strictEqual(sb.pendingFiles.length, 0, 'Monaco 区不得受理为附件');
});

test('拖到侧栏（main-area 外）：主落区不受理为附件，但仍阻止 file:// 导航', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'sidebar' }, { tagName: 'BODY' }]);
    // 主落区 drop：目标不在 main-area → 不 preventDefault、不入队
    const ev = fakeEvent({ types: ['Files'], files: [fakeFile('a.xlsx', XLSX)], target });
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(sb.pendingFiles.length, 0, '侧栏不得受理为附件');
    // document 护栏：必须 preventDefault，否则浏览器默认导航到 file:// →
    // Tauri open_external 会用 rundll32 以系统默认程序打开该文件
    const guard = sb.__$.handlersFor('document', 'drop');
    assert.ok(guard.length >= 1, 'document 级导航护栏应已注册');
    const ev2 = fakeEvent({ types: ['Files'], files: [fakeFile('a.xlsx', XLSX)], target });
    guard[guard.length - 1].call(sb.document, ev2);
    assert.strictEqual(ev2._prevented, true, '落区外拖放必须阻止 file:// 导航');
});

test('document 导航护栏对纯文本拖放不 preventDefault', () => {
    const sb = makeSandbox();
    const guards = sb.__$.handlersFor('document', 'dragover');
    assert.ok(guards.length >= 1);
    const ev = fakeEvent({ types: ['text/plain'], target: fakeEl('TEXTAREA') });
    guards[guards.length - 1].call(sb.document, ev);
    assert.strictEqual(ev._prevented, false, '护栏只拦文件，不得影响文本拖放');
});

test('主内容区遮罩：dragenter 点亮，dragleave 计数归零后熄灭', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    const enter = sb.__$.handlersFor('.main-area', 'dragenter');
    const leave = sb.__$.handlersFor('.main-area', 'dragleave');
    enter[0].call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), true, 'dragenter 应点亮遮罩');
    enter[0].call(sb.__self, fakeEvent({ types: ['Files'], target }));   // 嵌套子元素再 enter
    leave[0].call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), true,
        '计数器未归零时遮罩应持续显示（子元素 enter/leave 不得闪烁）');
    leave[0].call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), false, '计数归零后熄灭');
});

test('主内容区遮罩：drop 后立即熄灭且计数器归零', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    const enter = sb.__$.handlersFor('.main-area', 'dragenter')[0];
    const leave = sb.__$.handlersFor('.main-area', 'dragleave')[0];
    const drop = sb.__$.handlersFor('.main-area', 'drop')[0];

    // 连续 3 次 dragenter（嵌套子元素各发一次）把计数器抬到 3
    enter.call(sb.__self, fakeEvent({ types: ['Files'], target }));
    enter.call(sb.__self, fakeEvent({ types: ['Files'], target }));
    enter.call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), true);

    drop.call(sb.__self, fakeEvent({ types: ['Files'], files: [fakeFile('a.xlsx', XLSX)], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), false, 'drop 后遮罩必须熄灭');

    /* 计数器残留必须用「再跑一轮 enter/leave」才观得到。
       上一版只断言「drop 后遮罩已熄灭」，但 drop 里的 hideOverlay 是无条件调的，
       遮罩本就已经藏了 —— 计数器停在 3 还是 0 在这个路径上完全不可观测，
       实测变异 M12（删掉 drop 里的 val = 0）因此 SURVIVED。

       现改为：drop 后再 enter 一次、leave 一次。
         - 计数器已归零：0 → 1 → 0 → 遮罩熄灭 ✅
         - 计数器停在 3：3 → 4 → 3 > 0 → 遮罩依旧亮着 ❌（杀死变异）
       这才是「drop 后遮罩会永久卡住/不再正常显示」的真实可观测后果。 */
    enter.call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), true, 'drop 后新一轮拖入应重新点亮遮罩');
    leave.call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), false,
        'drop 未重置计数器时，新一轮 enter+leave 无法让遮罩熄灭（会卡在显示态）');
});

test('dragend 兜底收起遮罩（异常路径下计数器不会卡住）', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    sb.__$.handlersFor('.main-area', 'dragenter')[0].call(sb.__self, fakeEvent({ types: ['Files'], target }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), true);
    const endHandlers = sb.__$.handlersFor('document', 'dragend');
    assert.ok(endHandlers.length >= 1, 'dragend 兜底应已注册');
    endHandlers[endHandlers.length - 1].call(sb.document, fakeEvent({ types: ['Files'] }));
    assert.strictEqual(overlayActive(sb, '#mainDropOverlay'), false,
        'dragend（如按 Esc 取消拖放）必须收起遮罩');
});

test('.main-area 缺失时不抛异常（片段未注入的降级场景）', () => {
    assert.doesNotThrow(() => makeSandbox({ mainAreaMissing: true }),
        'mainArea.length 为 0 时应跳过绑定，不得抛错');
});

// ══════════════════════════════════════════════════════════════
// 名额守卫（acceptDroppedFiles）
// ══════════════════════════════════════════════════════════════

test('一次拖入多张图片：名额用本地计数器，不得因异步 push 而超限', () => {
    const sb = makeSandbox({ max: 3 });
    const files = [fakeFile('a.png', 'image/png'), fakeFile('b.png', 'image/png'),
                   fakeFile('c.png', 'image/png'), fakeFile('d.png', 'image/png'),
                   fakeFile('e.png', 'image/png')];
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self,
        fakeEvent({ types: ['Files'], files, target }));
    // 图片是异步 push，此处仍在 pendingAsync 中；受理数必须 ≤ 名额
    assert.ok(sb.__pendingAsync.length <= 3,
        `只看 pendingFiles.length 会让 5 张图全部放行，实际受理 ${sb.__pendingAsync.length}`);
    assert.ok(sb.__toasts.some(t => String(t.msg).includes('attachment_partial_limit')),
        '超出部分应提示「部分未添加」，实际 toasts=' + JSON.stringify(sb.__toasts));
});

test('名额已满时拖入文件：不受理且提示 attachment_limit', () => {
    const sb = makeSandbox({ max: 10 });
    for (let i = 0; i < 10; i++) sb.pendingFiles.push({ type: 'file', name: 'pre' + i, size: 1, attachmentsType: 'file' });
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self,
        fakeEvent({ types: ['Files'], files: [fakeFile('new.xlsx', XLSX)], target }));
    assert.strictEqual(sb.pendingFiles.length, 10, '满额时不得继续入队');
    assert.ok(sb.__toasts.some(t => String(t.msg).includes('attachment_limit')));
});

test('拖放空文件列表：不提示、不入队、仍 preventDefault（阻止导航）', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    const ev = fakeEvent({ types: ['Files'], files: [], target });
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, true);
    assert.strictEqual(sb.pendingFiles.length, 0);
    assert.strictEqual(sb.__toasts.length, 0);
});

test('MIME 为空的未知类型文件按 file 处理（不得误判为图片）', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self,
        fakeEvent({ types: ['Files'], files: [fakeFile('weirdfile', '')], target }));
    assert.strictEqual(sb.pendingFiles.length, 1);
    assert.strictEqual(sb.pendingFiles[0].attachmentsType, 'file');
    assert.strictEqual(sb.__pendingAsync.length, 0, '空 MIME 不得走图片异步分支');
});

test('主内容区 drop 兼容 jQuery 包装事件（只有 originalEvent.dataTransfer）', () => {
    // filesOf 已移入 IIFE 闭包，无法直接调用；改走公开路径观测最终入队结果。
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    const files = [fakeFile('wrapped.xlsx', XLSX)];
    const ev = {
        target,
        originalEvent: { dataTransfer: { files, types: ['Files'] } },
        _prevented: false,
        preventDefault() { this._prevented = true; },
        stopPropagation() {},
    };
    sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev);
    assert.strictEqual(ev._prevented, true, 'jQuery 包装形态也须接管');
    assert.strictEqual(sb.pendingFiles.length, 1, '应从 originalEvent.dataTransfer 取到文件');
});

test('无 dataTransfer 的 drop 不得抛异常', () => {
    const sb = makeSandbox();
    const target = fakeEl('DIV', [{ tagName: 'DIV', className: 'main-area' }]);
    const ev = { target, _prevented: false, preventDefault() { this._prevented = true; }, stopPropagation() {} };
    assert.doesNotThrow(() => sb.__$.handlersFor('.main-area', 'drop')[0].call(sb.__self, ev));
    assert.strictEqual(sb.pendingFiles.length, 0);
});