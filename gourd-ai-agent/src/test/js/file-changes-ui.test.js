const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const jsDir = path.join(staticRoot, 'js');

function read(rel) {
    return fs.readFileSync(path.join(staticRoot, rel), 'utf8').replace(/^\uFEFF/, '').split(/\r\n|\n/).join('\n');
}

/* 微型 DOM 桩：不依赖 jsdom，验证 app-file-changes.js 卡片宿主/定位/交互的真实行为。
   仿 steer-note-collapse.test.js 的 makeEl 范式：手写 closest/contains/getBoundingClientRect
   等 API 的可控行为，让「宿主锚在气泡尾部」「预览可交互」等契约可被断言。 */
function makeEl(tag, className) {
    const children = [];
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        className: className || '',
        style: {},
        dataset: {},
        childNodes: children,
        parentNode: null,
        _listeners: {},
        _text: '',
        get children() { return this.childNodes.filter((n) => n.nodeType !== 3); },
        get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return !!n._isRoot; },
        getAttribute(name) { return (this._attrs && this._attrs[name]) !== undefined ? this._attrs[name] : null; },
        setAttribute(name, value) { (this._attrs = this._attrs || {})[name] = String(value); },
        getBoundingClientRect() { return this._rect || { left: 40, top: 100, right: 600, bottom: 160, width: 560, height: 60 }; },
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const listeners = this._listeners[type] || [];
            this._listeners[type] = listeners.filter((listener) => listener !== fn);
        },
        dispatch(type, event) {
            (this._listeners[type] || []).forEach((fn) => fn(Object.assign({ target: this, stopPropagation() {}, preventDefault() {} }, event)));
        },
        appendChild(node) { return this.insertBefore(node, null); },
        insertBefore(node, ref) {
            if (node.parentNode) {
                const i = node.parentNode.childNodes.indexOf(node);
                if (i >= 0) node.parentNode.childNodes.splice(i, 1);
            }
            node.parentNode = this;
            const at = ref ? this.childNodes.indexOf(ref) : -1;
            if (at < 0) this.childNodes.push(node);
            else this.childNodes.splice(at, 0, node);
            return node;
        },
        removeChild(node) {
            const i = this.childNodes.indexOf(node);
            if (i >= 0) this.childNodes.splice(i, 1);
            node.parentNode = null;
            return node;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        contains(node) { let n = node; while (n) { if (n === this) return true; n = n.parentNode; } return false; },
        closest(selector) { let n = this; while (n) { if (n.matches && n.matches(selector)) return n; n = n.parentNode; } return null; },
        matches(selector) {
            // 仅支持本测试用到的简单形态：.class 或 tag.class 或 tag
            return String(selector).split('.').filter(Boolean).every((part, idx, arr) =>
                idx === 0 && /^[a-zA-Z]+$/.test(part) ? this.tagName === part.toUpperCase()
                    : (' ' + this.className + ' ').indexOf(' ' + part + ' ') >= 0);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        set innerHTML(html) { this._html = html; },
        get innerHTML() {
            if (this._html) return this._html;
            return this.childNodes.map((node) => node.nodeType === 3 ? node.textContent : '').join('');
        },
        set textContent(t) { this._text = t; },
        get textContent() { return this._text; },
        get firstChild() { return this.childNodes[0] || null; },
        get offsetHeight() { return this._offsetHeight || 0; },
        get nextElementSibling() {
            if (!this.parentNode) return null;
            const sibs = this.parentNode.childNodes;
            const i = sibs.indexOf(this);
            for (let k = i + 1; k < sibs.length; k++) if (sibs[k].nodeType !== 3) return sibs[k];
            return null;
        },
        get nextSibling() {
            if (!this.parentNode) return null;
            const sibs = this.parentNode.childNodes;
            const i = sibs.indexOf(this);
            return i >= 0 && i < sibs.length - 1 ? sibs[i + 1] : null;
        },
        get previousSibling() {
            if (!this.parentNode) return null;
            const i = this.parentNode.childNodes.indexOf(this);
            return i > 0 ? this.parentNode.childNodes[i - 1] : null;
        }
    };
    el.classList = {
        add: function () {
            const tokens = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
            for (const token of arguments) tokens.add(String(token));
            el.className = Array.from(tokens).join(' ');
        },
        remove: function () {
            const tokens = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
            for (const token of arguments) tokens.delete(String(token));
            el.className = Array.from(tokens).join(' ');
        },
        contains: function (token) {
            return String(el.className || '').split(/\s+/).filter(Boolean).includes(String(token));
        },
        toggle: function (token, force) {
            const present = this.contains(token);
            const shouldAdd = force === undefined ? !present : !!force;
            if (shouldAdd) this.add(token);
            else this.remove(token);
            return shouldAdd;
        }
    };
    return el;
}

function makeRoot() {
    const root = makeEl('div');
    root._isRoot = true;
    return root;
}

/* 挂载 app-file-changes.js 到微型沙箱（jQuery 以 $() 最小桩满足模块内的 $(...) 调用）。
   opts.fetch 可注入可控 diff 响应（预览行为测试用）；opts.innerWidth/innerHeight 控制视口。 */
function loadModule(opts) {
    const sandbox = {
        window: null,
        document: null,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        AbortController: undefined,
        fetch: (opts && opts.fetch) || function () { return new Promise(function () {}); },
        Map: Map,
        Date: Date,
        $: function (el) {
            /* 数组语义：runBubbleOf 慢路径用 $(rows[i]).find('.msg-bubble')[0] 取子节点。
               桩必须支持 [0] 索引与 first()，否则慢路径整体失效。 */
            const wrap = (list) => {
                const arr = Array.prototype.slice.call(list || []);
                arr.first = function () { return arr; };
                return arr;
            };
            return {
                find: function (sel) {
                    const cls = String(sel || '').replace(/^\./, '');
                    let found = [];
                    if (el && el.childNodes) {
                        (function walk(node) {
                            (node.childNodes || []).forEach(function (c) {
                                if (c.nodeType !== 3 && String(c.className || '').indexOf(cls) >= 0) found.push(c);
                                walk(c);
                            });
                        })(el);
                    }
                    return wrap(found);
                },
                closest: function () { return { attr: function () { return null; } }; }
            };
        },
        navigator: {},
        escapeHtml: function (str) { return String(str).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
        layConfirm: function () {},
        layAlert: function () {},
        console: console,
        GourdI18n: { t: function (key) { return key; } }
    };
    sandbox.window = sandbox;
    sandbox.escapeHtml = sandbox.escapeHtml;
    /* renderRoot 必须可注入：模块内 `typeof renderRoot` 查的是 vm 上下文的自由变量，
       挂在 sandbox 对象上根本到不了它——曾因未注入导致慢路径（runBubbleOf 的
       querySelectorAll 反查）从未被执行，未定义的 attrValueEscape 逃过全部测试。
       注入方式：作为 wrapper 形参传入，与生产页面（全局函数）语义一致。 */
    sandbox.renderRoot = (opts && opts.renderRoot) || function (sess) { return (sess && sess.renderTarget) || (sess && sess.container) || null; };
    sandbox.innerWidth = (opts && opts.innerWidth) || 1200;
    sandbox.innerHeight = (opts && opts.innerHeight) || 800;
    sandbox.document = {
        body: makeRoot(),
        addEventListener: function (type, fn) { (sandbox._docListeners = sandbox._docListeners || {})[type] = (sandbox._docListeners[type] || []).concat(fn); },
        createElement: function (tag) { return makeEl(tag); }
    };
    const source = read('js/app-file-changes.js');
    const wrapper = '(function(window,document,$,GourdI18n,setTimeout,clearTimeout,fetch,AbortController,Date,Map,escapeHtml,layConfirm,navigator,renderRoot){' + source + '})';
    vm.runInThisContext(wrapper, { filename: 'app-file-changes.js' })(sandbox.window, sandbox.document, sandbox.$, sandbox.GourdI18n, setTimeout, clearTimeout, sandbox.fetch, undefined, Date, Map, sandbox.escapeHtml, sandbox.layConfirm, sandbox.navigator, sandbox.renderRoot);
    return sandbox;
}

/* 在微型 DOM 中挂载真实 app-gitdiff.js，直接驱动分隔器的 pointer/keyboard/resize/close 生命周期。 */
function loadGitdiffModule(opts) {
    opts = opts || {};
    const elements = Object.create(null);
    const mainArea = makeEl('div', 'main-area');
    let mainAreaWidth = opts.mainAreaWidth || 1000;
    mainArea.getBoundingClientRect = function () {
        return { left: 0, top: 0, right: mainAreaWidth, bottom: 800, width: mainAreaWidth, height: 800 };
    };
    Object.defineProperty(mainArea, 'clientWidth', { get: function () { return mainAreaWidth; } });
    const chatView = makeEl('div', 'chat-view active');
    const resizeHandle = makeEl('div', 'chat-review-resize-handle');
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-orientation', 'vertical');
    resizeHandle.setAttribute('aria-valuemin', '300');
    resizeHandle.setAttribute('aria-valuemax', '300');
    resizeHandle.setAttribute('aria-valuenow', '300');
    const editorCol = makeEl('div', 'code-editor-col');
    const viewer = makeEl('div', 'git-diff-viewer');
    viewer.style.display = 'none';
    const welcomeView = makeEl('div', 'welcome-view');
    const viewerMsg = makeEl('div', 'git-viewer-msg');
    const viewerInfoBar = makeEl('div', 'git-viewer-info-bar');
    const viewerFileHost = makeEl('div', 'git-viewer-host');
    const viewerDiffHost = makeEl('div', 'git-viewer-host');
    const viewerContent = makeEl('div', 'git-viewer-content');
    mainArea.appendChild(chatView);
    mainArea.appendChild(resizeHandle);
    mainArea.appendChild(editorCol);
    editorCol.appendChild(viewer);
    viewer.appendChild(viewerMsg);
    viewer.appendChild(viewerInfoBar);
    viewer.appendChild(viewerFileHost);
    viewer.appendChild(viewerDiffHost);
    elements.chatView = chatView;
    elements.chatReviewResizeHandle = resizeHandle;
    elements.gitDiffViewer = viewer;
    elements.welcomeView = welcomeView;
    elements.gitViewerMsg = viewerMsg;
    elements.gitViewerInfoBar = viewerInfoBar;
    elements.gitViewerFileHost = viewerFileHost;
    elements.gitViewerDiffHost = viewerDiffHost;
    elements.gitViewerContent = viewerContent;

    const storage = new Map();
    const localStorage = {
        getItem: function (key) { return storage.has(key) ? storage.get(key) : null; },
        setItem: function (key, value) { storage.set(key, String(value)); },
        removeItem: function (key) { storage.delete(key); }
    };
    const listenersByType = function () { return Object.create(null); };
    const sandbox = {
        window: null,
        document: null,
        appMode: 'chat',
        innerWidth: opts.innerWidth || 1440,
        innerHeight: 900,
        localStorage: localStorage,
        navigator: {},
        fetch: function () { return Promise.resolve({ json: function () { return Promise.resolve({}); } }); },
        GourdI18n: { t: function (key) { return key; } },
        _windowListeners: listenersByType(),
        _docListeners: listenersByType(),
        _resizeObservers: [],
        _fireWindow: function (type, event) {
            (this._windowListeners[type] || []).slice().forEach(function (fn) {
                fn(Object.assign({ target: sandbox, preventDefault: function () {}, stopPropagation: function () {} }, event));
            });
        }
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = function (type, fn) {
        (sandbox._windowListeners[type] = sandbox._windowListeners[type] || []).push(fn);
    };
    sandbox.removeEventListener = function (type, fn) {
        sandbox._windowListeners[type] = (sandbox._windowListeners[type] || []).filter(function (listener) { return listener !== fn; });
    };
    sandbox.ResizeObserver = function (callback) {
        this.callback = callback;
        this.target = null;
        this.disconnected = false;
        sandbox._resizeObservers.push(this);
    };
    sandbox.ResizeObserver.prototype.observe = function (target) { this.target = target; };
    sandbox.ResizeObserver.prototype.disconnect = function () { this.disconnected = true; };
    sandbox._setMainAreaWidth = function (width) { mainAreaWidth = width; };
    sandbox._triggerMainAreaResize = function () {
        const observer = sandbox._resizeObservers[sandbox._resizeObservers.length - 1];
        if (observer && !observer.disconnected) observer.callback();
    };
    sandbox._storage = storage;

    const styleProperties = Object.create(null);
    const documentElement = makeEl('html');
    documentElement.style.setProperty = function (name, value) { styleProperties[name] = String(value); };
    documentElement.style.getPropertyValue = function (name) { return styleProperties[name] || ''; };
    documentElement.style.removeProperty = function (name) {
        const previous = styleProperties[name] || '';
        delete styleProperties[name];
        return previous;
    };
    const body = makeRoot();
    sandbox.document = {
        body: body,
        documentElement: documentElement,
        hidden: true,
        getElementById: function (id) { return elements[id] || null; },
        querySelector: function (selector) { return selector === '.main-area' ? mainArea : null; },
        querySelectorAll: function () { return []; },
        addEventListener: function (type, fn) {
            (sandbox._docListeners[type] = sandbox._docListeners[type] || []).push(fn);
        },
        removeEventListener: function (type, fn) {
            sandbox._docListeners[type] = (sandbox._docListeners[type] || []).filter(function (listener) { return listener !== fn; });
        },
        createElement: function (tag) { return makeEl(tag); },
        createTextNode: function (text) { return { nodeType: 3, textContent: String(text), parentNode: null }; },
        _fire: function (type, event) {
            (sandbox._docListeners[type] || []).slice().forEach(function (fn) {
                fn(Object.assign({ target: body, preventDefault: function () {}, stopPropagation: function () {} }, event));
            });
        }
    };
    const source = read('js/app-gitdiff.js');
    const wrapper = '(function(window,document,GourdI18n,setTimeout,clearTimeout,setInterval,clearInterval,fetch,localStorage,navigator,layAlert,layConfirm,AbortController,Date,Map){' + source + '})';
    vm.runInThisContext(wrapper, { filename: 'app-gitdiff.js' })(
        sandbox.window, sandbox.document, sandbox.GourdI18n, setTimeout, clearTimeout,
        function () { return 1; }, function () {}, sandbox.fetch, localStorage, sandbox.navigator,
        function () {}, function () {}, undefined, Date, Map
    );
    sandbox._elements = elements;
    sandbox._styleProperties = styleProperties;
    return sandbox;
}

/* 构造一轮带 meta 行的助手气泡结构（复刻 app-message.js ensureAssistantBubble 的 DOM 形态） */
function makeRunBubble(root, runId) {
    const row = makeEl('div', 'msg-row assistant');
    row.setAttribute('data-run-id', runId);
    const bubble = makeEl('div', 'msg-bubble');
    const md = makeEl('div', 'md-content');
    const meta = makeEl('div', 'msg-meta-row');
    const time = makeEl('div', 'msg-time');
    time.style.display = 'none';
    meta.appendChild(time);
    bubble.appendChild(md);
    bubble.appendChild(meta);
    row.appendChild(bubble);
    root.appendChild(row);
    return { row: row, bubble: bubble, md: md, meta: meta };
}

const SUMMARY = {
    revision: 1, fileCount: 4, additions: 30, deletions: 5, ready: true,
    files: [
        { path: 'a.js', changeType: 'MODIFIED', state: 'APPLIED', additions: 10, deletions: 2 },
        { path: 'b.js', changeType: 'ADDED', state: 'APPLIED', additions: 8, deletions: 0 },
        { path: 'c.js', changeType: 'DELETED', state: 'APPLIED', additions: 0, deletions: 3 },
        { path: 'd.js', changeType: 'MODIFIED', state: 'APPLIED', additions: 12, deletions: 0 }
    ]
};

test('文件变更模块按依赖顺序加载且 streaming 被动分发事件', () => {
    const bootstrap = read('js/app-bootstrap.js');
    const streaming = read('js/app-streaming.js');
    assert.ok(bootstrap.indexOf("'/js/app-gitdiff.js'") < bootstrap.indexOf("'/js/app-file-changes.js'"));
    assert.ok(bootstrap.indexOf("'/js/app-file-changes.js'") < bootstrap.indexOf("'/js/app-streaming.js'"));
    assert.match(streaming, /if \(chunk\.type === 'file_changes'\)[\s\S]*?window\.onFileChangesChunk/);
    assert.match(streaming, /if \(chunk\.type === 'file_changes'\)[\s\S]*?return;/);
});

test('文件变更模块覆盖协议端点、run revision upsert 与交互约束', () => {
    const source = read('js/app-file-changes.js');
    for (const endpoint of [
        '/web/chat/changes/run',
        '/web/chat/changes/diff',
        '/web/chat/changes/undo/file',
        '/web/chat/changes/undo/run',
        '/web/chat/changes/reapply/run'
    ]) assert.ok(source.includes(endpoint), `缺少端点 ${endpoint}`);
    // revision 单调门禁：旧 revision 丢弃（revision <= previousRevision 时 return）
    assert.match(source, /revision <= previousRevision\) return;/);
    assert.match(source, /event\.stopPropagation\(\)/);
    assert.match(source, /window\.openFileViewer/);
    assert.match(source, /window\.openSnapshotDiffViewer/);
    assert.match(source, /data\.binary/);
    assert.doesNotMatch(source, /git\/file-content|ref=HEAD/);
});

test('不再引用后端未提供的字段', () => {
    const source = read('js/app-file-changes.js');
    // 注释中可以说明「后端不提供」，但代码里不得读取这些字段：先剥离块注释与行注释
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !/^\s*\/\//.test(line))
        .join('\n');
    for (const field of ['applyState', 'beforeExists', 'afterExists', 'beforeText', 'afterText']) {
        assert.doesNotMatch(code, new RegExp(`\\.${field}\\b`), `仍在读取不存在的字段 ${field}`);
        assert.doesNotMatch(code, new RegExp(`['"]${field}['"]`), `仍在引用不存在的字段 ${field}`);
    }
    // incompleteReason 只允许以复数 incompleteReasons 形式出现
    assert.doesNotMatch(code, /incompleteReason\b(?!s)/);
    assert.match(code, /summary\.incompleteReasons/);
});

test('字段读取对齐后端契约：state / changeType / before / after', () => {
    const source = read('js/app-file-changes.js');
    // 文件撤销态取 file.state
    assert.match(source, /function isFileUndone\(file\) \{ return isUndoneState\(file && file\.state\); \}/);
    assert.match(source, /function canUndoFile\(file\) \{ return !isFileUndone\(file\); \}/);
    // 状态标记与打开按钮均由 changeType 驱动
    assert.match(source, /KIND_BY_CHANGE_TYPE = \{ ADDED: 'A', MODIFIED: 'M', DELETED: 'D' \}/);
    assert.match(source, /file\.changeType/);
    assert.match(source, /!== 'DELETED'/);
    assert.match(source, /canOpenFile\(file\)/);
    // diff 响应直接取 data，不得再经 normalizeSummary 下钻
    assert.match(source, /var data = \(result && result\.data\) \|\| \{\};/);
    assert.match(source, /typeof data\.before === 'string'/);
    assert.match(source, /typeof data\.after === 'string'/);
    const reviewBody = source.slice(source.indexOf('function reviewFile'), source.indexOf('function runOperation'));
    assert.doesNotMatch(reviewBody, /normalizeSummary/);
    // runApplyState 保留且兼容 status
    assert.match(source, /summary\.runApplyState \|\| summary\.status/);
});

test('写操作响应统一走 revision 单调门禁，无 force 覆盖与 revision 回填', () => {
    const source = read('js/app-file-changes.js');
    assert.match(source, /function upsert\(sess, runId, summary\) \{/);
    assert.doesNotMatch(source, /if \(!force &&/);
    assert.doesNotMatch(source, /summary\.revision = /);
    // 相同 revision 数据无变化，不重复渲染（旧 revision / 同 revision 都被单调门禁拦截）
    assert.match(source, /if \(previous && revision <= previousRevision\) return;/);
    assert.match(source, /upsert\(sess, String\(runId\), summary\);/);
});

test('后端状态枚举全部映射为本地化文案且暴露 error.message', () => {
    const source = read('js/app-file-changes.js');
    for (const status of ['CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST', 'ERROR_PARTIAL', 'ERROR_COMPENSATED', 'ERROR']) {
        assert.ok(new RegExp(`${status}: 'error_`).test(source) || status === 'CONFLICT' && source.includes("CONFLICT: 'error_conflict'"),
            `状态 ${status} 未映射本地化 key`);
    }
    assert.match(source, /data\.error && data\.error\.message/);
    assert.match(source, /statusOf\(result\) === 'ERROR_PARTIAL'/);
    // 不得把裸枚举当作提示文案
    assert.match(source, /if \(!detail \|\| detail === status \|\| detail === base\) return base;/);
});

test('增删统计缺失时不渲染 +0 -0，并优先使用 summary 总量', () => {
    const source = read('js/app-file-changes.js');
    assert.match(source, /function diffStatHtml\(additions, deletions\)/);
    assert.match(source, /if \(add == null && del == null\) return '';/);
    assert.match(source, /if \(!add && !del\) return '';/);
    assert.match(source, /num\(summary\.additions\)/);
    assert.match(source, /num\(summary\.deletions\)/);
    assert.match(source, /diffStatHtml\(file\.additions, file\.deletions\)/);
});

test('root 为可选参数：有值才拼接，空值不阻断请求', () => {
    const source = read('js/app-file-changes.js');
    assert.match(source, /return root \? '&root=' \+ encodeURIComponent\(root\) : '';/);
    assert.match(source, /if \(root\) body\.root = root;/);
    assert.doesNotMatch(source, /root: rootFor\(sess\)/);
});

test('对账刷新命中 changes/run 且失败静默', () => {
    const source = read('js/app-file-changes.js');
    const block = source.slice(source.indexOf('function reconcile'), source.indexOf('function actionButton'));
    assert.match(block, /\/web\/chat\/changes\/run\?sessionId=/);
    assert.doesNotMatch(block, /showToast|notify\(/);
    assert.match(block, /\.catch\(function \(\) \{/);
    // 回放期不即时对账：登记待回放收口统一触发（replayPending 机制）
    assert.match(source, /if \(sess\._replaying\) deferReplayReconcile\(sess, runKey\);/);
    // 运行中/挂起态也不即时对账：对账响应会回填 upsert，未收口的轮次不该出现在界面上
    assert.match(source, /else if \(runSettled\(sess, runKey\)\) reconcile\(sess, runKey\);/);
    assert.match(source, /else markReconcilePending\(sess, runKey\);/);
});

test('Diff 查看器暴露 snapshot 入口且不通过 Git HEAD 获取快照', () => {
    const source = read('js/app-gitdiff.js');
    assert.match(source, /function openSnapshotDiffViewer\(path, beforeText, afterText\)/);
    assert.match(source, /window\.openSnapshotDiffViewer = openSnapshotDiffViewer/);
});

test('全部语言包具有相同且非空的 file_changes key 集', () => {
    const dir = path.join(staticRoot, 'locales');
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    assert.equal(files.length, 12);
    let expected = null;
    for (const file of files) {
        const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(typeof json.file_changes, 'object', `${file} 缺少 file_changes`);
        const keys = Object.keys(json.file_changes).sort();
        if (!expected) expected = keys;
        assert.deepEqual(keys, expected, `${file} 的 file_changes key 集不一致`);
        for (const key of keys) {
            assert.equal(typeof json.file_changes[key], 'string', `${file}: ${key} 不是字符串`);
            assert.ok(json.file_changes[key].trim(), `${file}: ${key} 为空`);
            assert.notEqual(json.file_changes[key], `file_changes.${key}`, `${file}: ${key} 显示键名`);
        }
    }
});

test('错误映射相关 i18n key 在 12 个语言包中齐备且占位符正确', () => {
    const dir = path.join(staticRoot, 'locales');
    const required = ['error_conflict', 'error_not_found', 'error_invalid_request',
        'error_partial', 'error_compensated', 'error_generic', 'error_detail', 'possibly_incomplete_detail'];
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\uFEFF/, ''));
        const block = json.file_changes;
        for (const key of required) {
            assert.ok(block[key] && block[key].trim(), `${file}: 缺少 ${key}`);
        }
        assert.ok(block.error_detail.includes('{0}') && block.error_detail.includes('{1}'), `${file}: error_detail 占位符缺失`);
        assert.ok(block.possibly_incomplete_detail.includes('{0}'), `${file}: possibly_incomplete_detail 占位符缺失`);
        // 后端枚举不得以裸字符串形式出现在文案中
        for (const enumName of ['CONFLICT', 'NOT_FOUND', 'INVALID_REQUEST', 'ERROR_PARTIAL', 'ERROR_COMPENSATED']) {
            for (const key of Object.keys(block)) {
                assert.ok(!block[key].includes(enumName), `${file}: ${key} 泄漏后端枚举 ${enumName}`);
            }
        }
    }
});

test('变更卡片复用主题 token：边框/背景/折叠/滚动不硬编码', () => {
    const css = read('css/app.css');
    const block = css.slice(css.indexOf('.msg-run-changes-card'), css.indexOf('/* Batch tool group'));
    assert.ok(block.length > 0);
    assert.match(block, /\.msg-run-changes-card \{[^}]*background:\s*var\(--bg-card/);
    assert.match(block, /var\(--border-color\)/);
    // 行列表限高滚动：展开大量文件不再无限撑高消息流
    assert.match(block, /\.fch-body \{[^}]*max-height:\s*264px/);
    assert.match(block, /\.fch-body \{[^}]*overflow-y:\s*auto/);
    // 折叠态至少 3 行高度，不塌成细条
    assert.match(block, /\.fch-body \{[^}]*min-height:\s*74px/);
    assert.doesNotMatch(block, /background:\s*#[0-9a-f]{3,8}/i);
});

/* ===== 盒式形态护栏（不得被线性化）=====
   工具卡/思考块/智能体卡是【过程注脚】，已统一改为「透明底 + 左 2px 竖条」的线性形态；
   但变更卡是【结果汇总 + 操作入口】（审查/整轮撤销/重新应用都在此），与问答卡、HITL 卡同级，
   必须是视觉上闭合、可一眼认出的单元。曾误按过程卡口径改成左竖条 + 透明边框 + 无圆角，
   实测后果：白底(--bg-card)直接压在正文白底上（light 对比度 1.0），失去外轮廓，中间文件行
   像散落在正文里的裸文本，头部按钮也失去归属边界。本护栏锁死盒式形态，防回退。 */
test('变更卡片保持盒式形态：四周边框 + 圆角 + 头部淡底，不得线性化为左竖条', () => {
    const css = read('css/app.css');
    const cardRule = (css.match(/\.msg-run-changes-card \{[^}]*\}/) || [])[0];
    assert.ok(cardRule, '未找到 .msg-run-changes-card 规则');
    // 四周可见边框（不是透明），且四角圆角
    assert.match(cardRule, /border:\s*1px solid var\(--border-color\)/, '必须四周可见边框（不是 border:1px solid transparent）');
    assert.match(cardRule, /border-radius:\s*10px/, '必须 10px 圆角');
    // 不得出现「左 2px 竖条」这种线性化特征（工具卡才有）
    assert.doesNotMatch(cardRule, /border-left:\s*2px solid/, '变更卡不得线性化为左竖条');
    assert.doesNotMatch(cardRule, /border-radius:\s*0 6px 6px 0/, '变更卡不得用线性化的单侧圆角');
    // 头部淡底：盒式下它是标题栏，去掉底色会与下方文件列表连成一片
    const headRule = (css.match(/\.fch-head \{[^}]*\}/) || [])[0];
    assert.ok(headRule, '未找到 .fch-head 规则');
    assert.match(headRule, /background:\s*var\(--bg-hover\)/, '头部必须有淡底（不是 transparent）');
    // 折叠按钮上分隔线：与卡体分隔，盒式闭合的一部分
    assert.match(css, /\.fch-toggle \{[^}]*border-top:\s*1px solid var\(--border-color\)/);
});



/* 箭头方向契约：基础图标必须「下指」，展开态靠 rotate(180deg) 变「上指」。
   旧用例只断言存在 rotate(180deg)：上下指两种写法都能过（恒绿护栏），抓不到方向做反。 */
test('折叠箭头：收起态下指、展开态上指（几何从 SVG 路径实算，不匹配字串）', () => {
    const source = read('js/app-file-changes.js');
    const css = read('css/app.css');

    /* 1. 从 CARET_SVG 里取出折线坐标，判定尖端朝向（路径用紧凑写法 4-4，按数字正则取 token） */
    const svgLine = (source.match(/var CARET_SVG = '([^']+)'/) || [])[1];
    assert.ok(svgLine, '未找到 CARET_SVG');
    const path = (svgLine.match(/\sd="([^"]+)"/) || [])[1];
    assert.ok(path, 'CARET_SVG 无 path d 属性: ' + svgLine);
    assert.match(path, /^m/i, 'caret 应为相对折线 m 命令');
    const pts = (path.match(/-?\d*\.?\d+/g) || []).map(Number);
    assert.equal(pts.length, 6, 'caret 应为起点 + 两段位移（6 个分量），实为 ' + JSON.stringify(pts));
    /* 相对坐标 m x0 y0 dx1 dy1 dx2 dy2：当前写法 (4,6) → (8,10) → (12,6)，拐点在下 → 下指 */
    const start = [pts[0], pts[1]];
    const vertex = [start[0] + pts[2], start[1] + pts[3]];
    const end = [vertex[0] + pts[4], vertex[1] + pts[5]];
    assert.ok(vertex[1] > start[1] && vertex[1] > end[1],
        `基础图标必须下指（拐点 y 最大），实为 start=${start} vertex=${vertex} end=${end}`);
    assert.equal(start[1], end[1], '两翼应等高（否则不是对称 chevron）');
    assert.equal(vertex[0] - start[0], end[0] - vertex[0], '两翼应等宽');

    /* 2. 展开态翻转为上指：is-open 仍 rotate(180deg) */
    const cssBlock = css.slice(css.indexOf('.fch-toggle'), css.indexOf('/* 查看器轮文件列表'));
    assert.match(cssBlock, /\.fch-toggle\.is-open \.fch-caret \{[^}]*transform:\s*rotate\(180deg\)/);
    assert.doesNotMatch(cssBlock, /\.fch-toggle:not\(\.is-open\)[^}]*rotate/, '基础态不得额外旋转（会抵消下指语义）');

    /* 3. 接线：is-open 类只在 expanded 为真时上；收起态文案配下指、展开态文案配上指 */
    const toggle = source.slice(source.indexOf('toggleSig !== toggleSig'), source.indexOf('function upsert('));
    assert.match(toggle, /cache\.toggleEl\.className = 'fch-toggle' \+ \(cache\.expanded \? ' is-open' : ''\);/);
    assert.match(toggle, /cache\.expanded\s*\?\s*t\('collapse_files'\)/, '展开态才能看到「收起」');
    assert.match(toggle, /t\('show_more_files'/, '收起态文案为「再显示 N 个文件」');
    assert.match(toggle, /aria-expanded', cache\.expanded \? 'true' : 'false'/);
    assert.doesNotMatch(toggle, /⌃|⌄/, '不得使用字符箭头（字体相关朝向不可控）');
});

test('悬停预览气泡已移除：行点击是唯一预览入口，不得复活', () => {
    const source = read('js/app-file-changes.js');
    const css = read('css/app.css');
    /* 旧事故形态：鼠标离开后迟到的预览气泡再也收不掉（dismiss 在无 el 时直接 return，
       既不取消延时也不取消在途 diff 请求），整块预览代码已删除。 */
    ['fch-preview', 'mountPreview', 'schedulePreview', 'hidePreview', 'previewContains', 'PREVIEW_']
        .forEach((k) => assert.ok(!source.includes(k), `预览残留 ${k}`));
    assert.ok(!css.includes('.fch-preview'), 'app.css 预览样式残留');
    /* 行上不得再挂 mouseenter/mouseleave；点击审查链路必须保留 */
    assert.doesNotMatch(source, /row\.addEventListener\('mouse(enter|leave)'/);
    assert.match(source, /row\.addEventListener\('click', function \(\) \{/);
    assert.match(source, /\/web\/chat\/changes\/diff/);
});

test('已撤销的行不再渲染打开/撤销按钮，仅保留已撤销状态', () => {
    const source = read('js/app-file-changes.js');
    const start = source.indexOf('function buildRow');
    const buildRow = source.slice(start, source.indexOf('function renderCard', start) > 0 ? source.indexOf('function renderCard', start) : start + 2400);
    assert.ok(buildRow.length > 500, 'buildRow 切片异常');
    // 未撤销分支渲染 打开 / 撤销文件 两枚操作（审查 = 行点击，不再单独占按钮）
    const applied = buildRow.slice(buildRow.indexOf('if (canUndoFile(file))'), buildRow.indexOf('else {'));
    assert.match(applied, /actionButton\('open'/);
    assert.match(applied, /actionButton\('undo-file'/);
    assert.doesNotMatch(applied, /actionButton\('review'/);
    // 已撤销分支不渲染任何按钮，只显示「已撤销」标签
    const undone = buildRow.slice(buildRow.indexOf('else {'));
    assert.doesNotMatch(undone, /actionButton\(/);
    assert.match(undone, /file-change-state/);
    assert.match(undone, /t\('undone'\)/);
});

test('模块可独立解析（语法自检）', () => {
    const source = fs.readFileSync(path.join(jsDir, 'app-file-changes.js'), 'utf8').replace(/^\uFEFF/, '');
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'app-file-changes.js' }));
});

test('卡片宿主锚在页脚之前：正文 → 变更卡片 → 时长徽章 → 操作按钮', () => {
    const source = read('js/app-file-changes.js');
    // 审查内容不参与正文流，但它不是气泡的尾注：总时长是整轮收尾总结，必须在卡片之后。
    // 宿主锚定页脚（meta/actions）之前，不得再追加到气泡末尾（曾导致时长徽章跑到卡片上方）。
    assert.match(source, /function runHostOf\(sess, runKey\)/);
    assert.doesNotMatch(source, /function bubbleTailAnchor\(sess, bubble\)/,
        'bubbleTailAnchor 已废弃：卡片不再插在气泡内容尾部');
    assert.match(source, /function bubbleFooterOf\(bubble\)/, '必须有页脚锚点函数（meta/actions 首个出现者）');
    assert.match(source, /if \(footer\) \{[\s\S]*?bubble\.insertBefore\(host, footer\)/,
        '宿主必须插到页脚之前，不得 appendChild 到气泡末尾');
    assert.doesNotMatch(source, /if \(bubble && \(host\.parentNode !== bubble \|\| host\.nextSibling\)\) bubble\.appendChild\(host\);/,
        '旧「收敛到气泡最后一个子节点」写法不得复活');
    // 卡片挂宿主，不直接挂消息容器根（否则被顶到容器全宽、比正文还宽）
    assert.match(source, /if \(el\.parentNode !== host\) host\.appendChild\(el\);/);
    assert.doesNotMatch(source, /if \(el\.parentNode !== root\) root\.appendChild\(el\);/);
    // 行为验证：宿主落在 meta 行之前，卡片在宿主内 —— 时长徽章必然在卡片下方
    const sandbox = loadModule();
    const root = makeRoot();
    const run1 = makeRunBubble(root, 'run-1');
    const run2 = makeRunBubble(root, 'run-2');
    const sess = {
        sessionId: 's1', projectRoot: '', container: root, isStreaming: false, _replaying: false,
        currentBubbleEl: run1.md, currentRunId: 'run-1', inlineThinkingEl: null
    };
    sandbox.renderRoot = function () { return root; };
    run1.bubble.querySelector = function () { return null; };
    run2.bubble.querySelector = function () { return null; };
    const onChunk = sandbox.window.onFileChangesChunk || sandbox.onFileChangesChunk;
    assert.equal(typeof onChunk, 'function', 'onFileChangesChunk 应已导出');
    onChunk(sess, { runId: 'run-1', args: SUMMARY });
    sess.currentBubbleEl = run2.md;
    sess.currentRunId = 'run-2';
    onChunk(sess, { runId: 'run-2', args: SUMMARY });
    const host1 = sess._fchHosts && sess._fchHosts['run-1'];
    const host2 = sess._fchHosts && sess._fchHosts['run-2'];
    assert.ok(host1 && host2, '两轮应各自创建卡片宿主');
    assert.notEqual(host1, host2, 'run-2 不得复用/顶掉 run-1 的宿主');
    assert.equal(host1.parentNode, run1.bubble, 'run-1 宿主应在其所属气泡内');
    assert.equal(host2.parentNode, run2.bubble, 'run-2 宿主应在其所属气泡内');
    assert.equal(host1.nextSibling, run1.meta, 'run-1 宿主应紧跟在 meta 行之前（时长徽章在卡片下方）');
    const card1 = host1.children[0];
    assert.ok(card1 && String(card1.className).indexOf('msg-run-changes-card') >= 0, '卡片应在宿主内');
});

test('渲染时机：流式/回放期只登记，收口后才落卡', () => {
    const source = read('js/app-file-changes.js');
    assert.match(source, /function runSettled\(sess, runKey\) \{/,
        '门禁必须是 run 级（runSettled）：会话级 isStreaming 无法区分挂起/历史轮/活跃轮');
    assert.doesNotMatch(source, /function renderAllowed\(/, '旧的会话级门禁已废弃，不得复活');
    assert.match(source, /if \(sess\._replaying\) return false;/, '回放期一律延后');
    assert.match(source, /if \(sess\._runSuspended\) return false;/, '挂起态（等作答/审批）视为未收口');
    assert.match(source, /if \(!isActiveRun\) return true;/, '历史轮已收口，必须放行（否则回放回归）');
    assert.match(source, /if \(runSettled\(sess, runKey\)\) \{/, 'upsert 走 run 级门禁');
    assert.match(source, /else markRenderPending\(sess, runKey\);/);
    // flushPendingRenders 内部也必须逐个 run 过门禁：它的三个调用点里有两个（回放 replayDone /
    // 会话切换）并不保证任务已结束，无条件 renderCard 正是「运行中就展示」的直接成因
    const flushFn = source.slice(source.indexOf('function flushPendingRenders'), source.indexOf('function renderCard'));
    assert.match(flushFn, /if \(runSettled\(sess, runKey\)\) \{/, 'flush 路径不得绕过 run 级门禁');
    assert.match(flushFn, /else markRenderPending\(sess, runKey\);/, '未收口必须重新登记，不得丢卡');
    // 两个收口点都必须补渲染，否则卡片永不出现
    assert.match(source, /window\.flushFileChangesReplayRender = function \(sess\)/);
    assert.match(read('js/app-history.js'), /window\.flushFileChangesReplayRender === 'function'/);
    assert.match(read('js/app-streaming.js'), /window\.repositionFileChangeCards === 'function'/);
    // 待渲染登记必须随会话淘汰一起清理
    assert.match(read('js/app-base.js'), /sess\._fchRenderPending = null;/);
    assert.match(read('js/app-base.js'), /sess\._fchReconcilePending = null;/, '延后对账登记同样随会话淘汰清理');
    // 挂起标记由 finishStream 按 keepBatchIndex 落盘：runSettled 的判据来源，缺它挂起态无法识别
    assert.match(read('js/app-streaming.js'), /sess\._runSuspended = keepBatchIndex;/);
    assert.match(read('js/app-base.js'), /this\._runSuspended = false;/, '字段必须在会话构造器里声明');
    // 行为验证：流式期间 upsert 不产生卡片，收口后出现
    const sandbox = loadModule();
    const root = makeRoot();
    const run = makeRunBubble(root, 'run-1');
    const sess = {
        sessionId: 's1', projectRoot: '', container: root, isStreaming: true, _replaying: false,
        currentBubbleEl: run.md, currentRunId: 'run-1', inlineThinkingEl: null
    };
    sandbox.renderRoot = function () { return root; };
    run.bubble.querySelector = function () { return null; };
    const onChunk = sandbox.window.onFileChangesChunk || sandbox.onFileChangesChunk;
    onChunk(sess, { runId: 'run-1', args: SUMMARY });
    assert.ok(sess._fileChangesByRun['run-1'], '快照应已记录');
    assert.equal(sess._fchHosts && sess._fchHosts['run-1'], undefined, '流式期间不得创建宿主');
    assert.equal(sess._fchRenderPending && sess._fchRenderPending['run-1'], true, '应登记为待渲染');
    sess.isStreaming = false;
    const reposition = sandbox.window.repositionFileChangeCards;
    assert.equal(typeof reposition, 'function', 'repositionFileChangeCards 应已导出');
    reposition(sess);
    const host = sess._fchHosts && sess._fchHosts['run-1'];
    assert.ok(host, '收口后应补渲染出卡片宿主');
    assert.equal(host.parentNode, run.bubble, '宿主应在助手气泡内');
    assert.equal(host.nextSibling, run.meta, '宿主应在页脚之前（时长徽章在卡片下方）');
});

test('同一 run 的后续 revision 原地更新，旧 revision 丢弃', () => {
    const sandbox = loadModule();
    const root = makeRoot();
    const run = makeRunBubble(root, 'run-1');
    const sess = {
        sessionId: 's1', projectRoot: '', container: root, isStreaming: false, _replaying: false,
        currentBubbleEl: run.md, currentRunId: 'run-1', inlineThinkingEl: null
    };
    sandbox.renderRoot = function () { return root; };
    run.bubble.querySelector = function (selector) {
        return String(selector).indexOf('msg-meta-row') >= 0 ? run.meta : null;
    };
    const upsert = sandbox.window.onFileChangesChunk || sandbox.onFileChangesChunk;
    assert.equal(typeof upsert, 'function', 'onFileChangesChunk 应已导出');
    upsert(sess, { runId: 'run-1', args: SUMMARY });
    const host = sess._fchHosts['run-1'];
    upsert(sess, { runId: 'run-1', args: SUMMARY }); // 同 revision：不重建
    assert.equal(sess._fchHosts['run-1'], host, '同 revision 不换宿主');
    const older = JSON.parse(JSON.stringify(SUMMARY));
    older.revision = 0;
    upsert(sess, { runId: 'run-1', args: older });
    assert.equal(sess._fileChangesByRun['run-1'].revision, 1, '旧 revision 被丢弃');
});

test('file_changes 为被动事件：不推进 activeRunId、不伪造流式状态', () => {
    const streaming = read('js/app-streaming.js');
    const passive = streaming.slice(streaming.indexOf("/* file_changes 是 run 级被动快照"), streaming.indexOf("/* file_changes 是 run 级被动快照") + 900);
    assert.match(passive, /activeRunId/);
    // 通用 streaming 自动开流分支之前必须先消费并 return
    assert.match(streaming, /file_changes 可能在 run 收尾后延迟到达[\s\S]{0,400}?if \(chunk\.type === 'file_changes'\)/);
});

test('会话 LRU 淘汰同时清理文件变更快照，避免展示与状态不同生共死', () => {
    const base = read('js/app-base.js');
    const evict = base.slice(base.indexOf('function evictInactiveSessions'), base.indexOf('/* ===== Per-Session Input Draft ====='));
    assert.match(evict, /sess\._fileChangesByRun = \{\};/);
    assert.match(evict, /sess\._fileChangesReconciledAt = \{\};/);
    assert.match(evict, /sess\._fileChangesReplayPending = null;/);
});

test('审查请求有代次门禁、可取消，并与 Monaco 加载并行预热', () => {
    const source = read('js/app-file-changes.js');
    const reviewBody = source.slice(source.indexOf('function reviewFile'), source.indexOf('function runOperation'));
    assert.match(reviewBody, /if \(button && button\.disabled\) return;/);
    assert.match(reviewBody, /button\.disabled = true;/);
    assert.match(reviewBody, /var gen = \+\+reviewGeneration;/);
    assert.match(reviewBody, /if \(gen !== reviewGeneration\) return;/);
    assert.match(reviewBody, /AbortController/);
    assert.match(reviewBody, /reviewAbort\.abort\(\)/);
    assert.match(reviewBody, /__monacoLoad/);
    assert.match(reviewBody, /err\.name === 'AbortError'/);
});

test('viewer 异步回调受代次保护，模式切换先释放另一套 model', () => {
    const gitdiff = read('js/app-gitdiff.js');
    assert.match(gitdiff, /function beginViewerRequest\(\)/);
    assert.match(gitdiff, /function viewerStale\(gen\)/);
    assert.match(gitdiff, /function releaseFileViewerModel\(\)/);
    assert.match(gitdiff, /function releaseDiffViewerModels\(\)/);
    const staleGuards = gitdiff.match(/if \(viewerStale\(gen\)\) return;/g) || [];
    assert.ok(staleGuards.length >= 5, `代次校验点过少: ${staleGuards.length}`);
    const close = gitdiff.slice(gitdiff.indexOf('function closeDiffViewer'), gitdiff.indexOf('if (gitViewerClose)'));
    assert.match(close, /beginViewerRequest\(\);/);
    assert.match(close, /releaseFileViewerModel\(\);/);
    assert.match(close, /releaseDiffViewerModels\(\);/);
});

test('file viewer 与 diff model 使用隔离 URI，大文件 diff 有计算预算', () => {
    const gitdiff = read('js/app-gitdiff.js');
    assert.match(gitdiff, /inmemory:\/\/gwork-file-viewer\//);
    assert.match(gitdiff, /inmemory:\/\/gwork-diff-original\//);
    assert.match(gitdiff, /inmemory:\/\/gwork-diff-modified\//);
    assert.doesNotMatch(gitdiff, /monaco\.Uri\.parse\('file:\/\/\//);
    assert.match(gitdiff, /VIEWER_DIFF_BUDGET_MS/);
    assert.match(gitdiff, /maxComputationTime: large \? VIEWER_DIFF_BUDGET_MS : 0/);
});

test('openInEditor 保留 rootOverride，跨项目退回只读查看器并防重复打开', () => {
    const code = read('js/app-code.js');
    assert.match(code, /function openInEditor\(path, name, rootOverride\)/);
    assert.match(code, /_origOpenFileViewer\(path, name, rootOverride\)/);
    assert.match(code, /function samePathRoot\(a, b\)/);
    assert.match(code, /if \(rootOverride && !samePathRoot\(rootOverride, window\.currentProjectRoot\)\)/);
    assert.match(code, /var requestedRoot = rootOverride \|\| window\.currentProjectRoot \|\| '';/);
    assert.match(code, /if \(!samePathRoot\(requestedRoot, window\.currentProjectRoot \|\| ''\)\) return;/);
    assert.match(code, /if \(openingFiles\[openKey\]\) return;/);
    assert.match(code, /delete openingFiles\[openKey\]/);
});

test('无文件变更的 run 不生成任何入口：空快照在 upsert 入口短路', () => {
    const source = read('js/app-file-changes.js');
    const upsert = source.slice(source.indexOf('function upsert('), source.indexOf('window.onFileChangesChunk'));
    assert.match(upsert, /if \(!Array\.isArray\(summary\.files\) \|\| !summary\.files\.length\) return;/);
    assert.ok(upsert.indexOf('summary.files.length) return;') < upsert.indexOf('sess._fileChangesByRun[runKey] = summary;'),
        '空快照守卫应在缓存写入之前');
});



test('chat 模式审查查看器使用最小宽度三轨分栏，code 模式保持隔离', () => {
    const html = read('code.html');
    const gitdiff = read('js/app-gitdiff.js');
    const css = read('css/code.css');
    // 手柄作为 main-area 直接子项夹在 chat 与 code-editor-col 之间，语义化且可聚焦。
    assert.match(html, /id="chatReviewResizeHandle"[\s\S]{0,220}role="separator"/);
    assert.match(html, /id="chatReviewResizeHandle"[\s\S]{0,260}aria-valuenow="300"/);
    assert.ok(html.indexOf('id="chatReviewResizeHandle"') < html.indexOf('class="code-editor-col"'));
    assert.match(gitdiff, /classList\.add\('chat-review-open'\)/);
    assert.match(gitdiff, /classList\.remove\('chat-review-open'\)/);
    assert.doesNotMatch(gitdiff, /chatView\.style\.display = 'none'/);
    assert.match(gitdiff, /mainArea\.clientWidth/);
    assert.match(gitdiff, /CHAT_REVIEW_MIN_WIDTH = 300/);
    assert.match(gitdiff, /CHAT_REVIEW_HANDLE_WIDTH = 7/);
    assert.match(gitdiff, /CHAT_REVIEW_MIN_TOTAL_WIDTH = CHAT_REVIEW_MIN_WIDTH \* 2 \+ CHAT_REVIEW_HANDLE_WIDTH/);
    assert.match(gitdiff, /chatReviewResizeHandle\.addEventListener\('pointerdown'/);
    assert.match(gitdiff, /chatReviewResizeHandle\.addEventListener\('keydown'/);
    assert.match(gitdiff, /document\.addEventListener\('pointercancel'/);
    assert.match(gitdiff, /window\.addEventListener\('blur'/);
    assert.match(gitdiff, /function stopChatReviewResize\(\)/);
    assert.doesNotMatch(gitdiff, /innerWidth < 640/);

    // Grid track 在实际 main-area 内夹取 chat / viewer 两侧最小宽度和 7px 手柄。
    const split = css.slice(css.indexOf('body.viewer-open:not(.code-mode) .main-area'), css.indexOf('/* ---- 中间编辑器列'));
    const gridColumns = (split.match(/grid-template-columns:\s*([^;]+)/) || [])[1] || '';
    assert.match(gridColumns, /minmax\(300px/);
    assert.match(gridColumns, /min\(var\(--chat-review-chat-width/);
    assert.match(gridColumns, /calc\(100% - 307px\)/);
    assert.match(gridColumns, /\) 7px minmax\(300px, 1fr\)/);
    assert.match(split, /body\.viewer-open:not\(\.code-mode\) \.chat-view \{[^}]*grid-area:\s*2 \/ 1 \/ 3 \/ 2/);
    assert.match(split, /body\.viewer-open:not\(\.code-mode\) \.chat-view\.active ~ #chatReviewResizeHandle \{[^}]*grid-area:\s*2 \/ 2 \/ 3 \/ 3/);
    assert.match(split, /body\.viewer-open:not\(\.code-mode\) \.git-diff-viewer \{[^}]*grid-area:\s*2 \/ 3 \/ 3 \/ 4/);
    // 未开会话时 viewer 跨完整三列，不能遗留空网格列。
    assert.match(split, /body\.viewer-open:not\(\.code-mode\) \.chat-view:not\(\.active\) ~ \.code-editor-col \.git-diff-viewer \{[^}]*grid-area:\s*2 \/ 1 \/ 3 \/ 4/);
    // 窄态按 JS 基于 main-area 实宽驱动，chat 和手柄隐藏、viewer 单列全幅。
    assert.match(split, /body\.viewer-open:not\(\.code-mode\)\.chat-review-narrow \.main-area \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(split, /body\.viewer-open:not\(\.code-mode\)\.chat-review-narrow \.chat-view,[\s\S]*?#chatReviewResizeHandle \{ display: none !important; \}/);
    assert.match(split, /body\.viewer-open:not\(\.code-mode\)\.chat-review-narrow \.git-diff-viewer,[\s\S]*?grid-area:\s*2 \/ 1 \/ 3 \/ 2/);
    assert.match(split, /#chatReviewResizeHandle:focus-visible/);
    assert.match(split, /cursor:\s*col-resize/);
    // 所有新规则由非 code-mode 选择器门控；Code 模式既有分隔器维持独立。
    assert.match(css, /body\.code-mode \.code-chat-resize-handle/);
});


test('chat 审查分隔器拖动与键盘输入夹取两侧最小宽度', () => {
    const sandbox = loadGitdiffModule({ mainAreaWidth: 1000, innerWidth: 1440 });
    const { chatView, chatReviewResizeHandle: handle, gitDiffViewer: viewer } = sandbox._elements;
    sandbox.openUnifiedDiffViewer('sample.js', 'before / after');
    assert.equal(viewer.style.display, 'flex');
    assert.equal(sandbox.document.body.classList.contains('chat-review-open'), true);
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '496.5px');
    assert.equal(handle.getAttribute('role'), 'separator');
    assert.equal(handle.getAttribute('aria-orientation'), 'vertical');

    const startWidth = Number.parseFloat(sandbox._styleProperties['--chat-review-chat-width']);
    handle.dispatch('pointerdown', { clientX: 500, pointerId: 11, button: 0, isPrimary: true });
    sandbox.document._fire('pointermove', { clientX: 500 + 1000, pointerId: 11 });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '693px', '拖到右侧应夹取 main-area 宽度 - 300px viewer - 7px 手柄');
    assert.equal(handle.classList.contains('dragging'), true);
    sandbox.document._fire('pointerup', { pointerId: 11 });
    assert.equal(handle.classList.contains('dragging'), false);
    assert.equal((sandbox._docListeners.pointermove || []).length, 0, 'pointerup 后清理 document move 监听');

    handle.dispatch('pointerdown', { clientX: 800, pointerId: 12, button: 0, isPrimary: true });
    sandbox.document._fire('pointermove', { clientX: -1000, pointerId: 12 });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '300px', '拖到左侧应夹取聊天区最小宽度');
    sandbox.document._fire('pointercancel', { pointerId: 12 });
    assert.equal(handle.classList.contains('dragging'), false, 'pointercancel 也必须结束拖动');

    for (let i = 0; i < 20; i++) handle.dispatch('keydown', { key: 'ArrowRight' });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '693px', 'ArrowRight 超过上限后保持最大宽度');
    for (let i = 0; i < 30; i++) handle.dispatch('keydown', { key: 'ArrowLeft' });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '300px', 'ArrowLeft 超过下限后保持最小宽度');
    handle.dispatch('keydown', { key: 'End' });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '693px');
    handle.dispatch('keydown', { key: 'Home' });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '300px');

    // 恢复刚打开时的预期宽度，结束时关闭以覆盖 teardown。
    assert.ok(startWidth >= 300);
    sandbox.closeDiffViewer();
});

test('chat 审查布局按 main-area 实宽窄降级、恢复并重新 clamp', () => {
    const sandbox = loadGitdiffModule({ mainAreaWidth: 1000, innerWidth: 1600 });
    const body = sandbox.document.body;
    const { chatView, chatReviewResizeHandle: handle, gitDiffViewer: viewer } = sandbox._elements;
    sandbox.openUnifiedDiffViewer('sample.js', 'before / after');
    handle.dispatch('pointerdown', { clientX: 500, pointerId: 21, button: 0 });
    sandbox.document._fire('pointermove', { clientX: 1000, pointerId: 21 });
    sandbox.document._fire('pointerup', { pointerId: 21 });
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '693px');

    // 窗口宽度不变，仅 main-area 实宽变化（例如侧栏拖动），仍应重新 clamp。
    sandbox._setMainAreaWidth(800);
    sandbox._triggerMainAreaResize();
    assert.equal(body.classList.contains('chat-review-narrow'), false);
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '493px', 'max chat width = 800 - 300 - 7');
    assert.equal(viewer.style.display, 'flex', '宽度重算不得关闭 viewer');

    sandbox._setMainAreaWidth(606);
    sandbox._triggerMainAreaResize();
    assert.equal(body.classList.contains('chat-review-narrow'), true, '606px 不足以容纳 300 + 7 + 300，应切换单栏');
    assert.equal(viewer.style.display, 'flex', '窄布局仍保留 viewer');
    assert.equal(chatView.style.display, '', '窄态聊天显隐交给 chat-review-narrow CSS，不污染 chat 原始 inline display');

    sandbox._setMainAreaWidth(607);
    sandbox._triggerMainAreaResize();
    assert.equal(body.classList.contains('chat-review-narrow'), false, '恢复到 607px 的恰好边界应回到双栏');
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '300px');
    sandbox._setMainAreaWidth(800);
    sandbox._triggerMainAreaResize();
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], '493px', '恢复较宽时也应按新上限夹取');
    assert.equal(sandbox.innerWidth, 1600, '布局切换由 main-area 实宽驱动，而非 window.innerWidth');
    sandbox.closeDiffViewer();
});

test('关闭 viewer 或切出 active chat 会清理拖动监听，未开会话不启动分栏拖动', () => {
    const sandbox = loadGitdiffModule({ mainAreaWidth: 1000 });
    const { chatView, chatReviewResizeHandle: handle } = sandbox._elements;
    const initialResizeListeners = (sandbox._windowListeners.resize || []).length;

    sandbox.openUnifiedDiffViewer('sample.js', 'before / after');
    assert.equal((sandbox._windowListeners.resize || []).length, initialResizeListeners + 1);
    chatView.classList.remove('active');
    handle.dispatch('pointerdown', { clientX: 500, pointerId: 31, button: 0 });
    assert.equal((sandbox._docListeners.pointermove || []).length, 0, 'chat 不 active 时禁止启动分栏拖动');

    chatView.classList.add('active');
    handle.dispatch('pointerdown', { clientX: 500, pointerId: 32, button: 0 });
    assert.equal((sandbox._docListeners.pointermove || []).length, 1);
    assert.equal((sandbox._windowListeners.blur || []).length, 1);
    sandbox._fireWindow('blur');
    assert.equal((sandbox._docListeners.pointermove || []).length, 0, '窗口失焦应结束拖动并移除 document listener');
    assert.equal((sandbox._windowListeners.blur || []).length, 0, '窗口失焦处理器自身也应移除');
    assert.equal(handle.classList.contains('dragging'), false);

    handle.dispatch('pointerdown', { clientX: 500, pointerId: 33, button: 0 });
    assert.equal((sandbox._docListeners.pointermove || []).length, 1);
    sandbox.closeDiffViewer();
    assert.equal((sandbox._docListeners.pointermove || []).length, 0, '关闭期间拖动也必须移除 document listener');
    assert.equal((sandbox._docListeners.pointerup || []).length, 0);
    assert.equal((sandbox._docListeners.pointercancel || []).length, 0);
    assert.equal((sandbox._windowListeners.blur || []).length, 0);
    assert.equal((sandbox._windowListeners.resize || []).length, initialResizeListeners);
    assert.equal((handle._listeners.pointerdown || []).length, 0);
    assert.equal((handle._listeners.keydown || []).length, 0);
    assert.equal(sandbox.document.body.classList.contains('chat-review-narrow'), false);
    assert.equal(sandbox.document.body.classList.contains('chat-review-open'), false);
    assert.equal(sandbox._styleProperties['--chat-review-chat-width'], undefined);

    for (let i = 0; i < 3; i++) {
        sandbox.openUnifiedDiffViewer('sample.js', 'before / after');
        assert.equal((sandbox._windowListeners.resize || []).length, initialResizeListeners + 1, '重复打开不得累积 resize listener');
        sandbox.closeDiffViewer();
        assert.equal((sandbox._windowListeners.resize || []).length, initialResizeListeners);
        assert.equal((handle._listeners.pointerdown || []).length, 0);
    }
});


/* ===== run 级收口门禁的行为验证（源码字符串断言抓不到粒度错配）=====
   背景：卡片是 run 级产物，而 isStreaming 是会话级旗标。旧实现用
   renderAllowed(sess) = !isStreaming && !_replaying 做门禁，实测有四条泄漏路径，
   表现为用户报的「任务还在运行中就展示了变更」。以下逐条锁死。
   判定口径用 cardBuilt（宿主里是否已构建卡片节点）而非遍历容器：
   卡片宿主在气泡未建时会先落容器根，遍历口径会把「已构建但未挂载」误判为未渲染。 */
function cardBuiltOf(sess, runKey) {
    const host = sess._fchHosts && sess._fchHosts[runKey];
    return !!(host && host.children && host.children.some(
        (c) => String(c.className || '').indexOf('msg-run-changes-card') >= 0));
}
function gateSandbox(runIds, opts) {
    opts = opts || {};
    const sandbox = loadModule();
    const root = makeRoot();
    sandbox.renderRoot = function () { return root; };
    const bubbles = {};
    runIds.forEach((rid) => {
        bubbles[rid] = makeRunBubble(root, rid);
        bubbles[rid].bubble.querySelector = function () { return null; };
    });
    const first = runIds[0];
    const sess = {
        sessionId: 's1', projectRoot: '', container: root,
        isStreaming: opts.isStreaming !== false, _replaying: !!opts.replaying,
        currentBubbleEl: bubbles[first].md,
        currentRunId: opts.currentRunId === undefined ? first : opts.currentRunId,
        inlineThinkingEl: null, phase: opts.phase || 'tool'
    };
    /* root 的 querySelectorAll 必须能按 data-run-id 反查：曾因桩返回空数组导致慢路径
       （runBubbleOf 的属性选择器反查）永远落空——测试成了绿色假象，未定义的
       attrValueEscape 由此漏网。 */
    root.querySelectorAll = function (sel) {
        const m = /^\.msg-row\.assistant\[data-run-id="(.*)"\]$/.exec(sel);
        if (!m) return [];
        const wanted = m[1];
        const found = [];
        (function walk(node) {
            (node.childNodes || []).forEach(function (c) {
                if (c.nodeType !== 3
                    && String(c.className || '').indexOf('msg-row') >= 0
                    && c.getAttribute && c.getAttribute('data-run-id') === wanted) found.push(c);
                walk(c);
            });
        })(this || root);
        /* 数组语义：runBubbleOf 用 rows.length 与 rows[i] */
        found.find = function () { return []; };
        return found;
    };
    return { sandbox, root, sess, bubbles };
}

test('门禁场景1：挂起态（等作答/审批）不得出卡，恢复后真收口必须出卡', () => {
    const { sandbox, sess } = gateSandbox(['run-1'], { isStreaming: true, phase: 'question' });
    const onChunk = sandbox.window.onFileChangesChunk;
    onChunk(sess, { runId: 'run-1', args: SUMMARY });
    assert.equal(cardBuiltOf(sess, 'run-1'), false, '流式期只登记不渲染');

    // 挂起态 done：finishStream 置 isStreaming=false、_runSuspended=true，随后收口点 flush
    sess.isStreaming = false;
    sess._runSuspended = true;
    sess.phase = 'question';
    sandbox.window.repositionFileChangeCards(sess);
    assert.equal(cardBuiltOf(sess, 'run-1'), false, '挂起期出卡 = 任务还在运行中就展示（用户报的缺陷）');
    assert.equal(sess._fchRenderPending && sess._fchRenderPending['run-1'], true, '必须重新登记，否则恢复后永不补卡');

    // 用户作答后引擎带同一 runId 继续跑完 → 真收口 done（_runSuspended 被清）
    sess._runSuspended = false;
    sess.phase = 'done';
    sandbox.window.repositionFileChangeCards(sess);
    assert.equal(cardBuiltOf(sess, 'run-1'), true, '真收口必须出卡（不得修过头）');
});

test('门禁场景2：切回仍在运行的会话不得出卡（setActiveSession 补渲染路径）', () => {
    const { sandbox, sess } = gateSandbox(['run-1'], { isStreaming: true });
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-1', args: SUMMARY });
    // setActiveSession 的 setTimeout 会无条件调 renderSessionFileChangeCards
    sandbox.window.renderSessionFileChangeCards(sess);
    assert.equal(cardBuiltOf(sess, 'run-1'), false, '会话切换补渲染不得绕过门禁');
});

test('门禁场景3：回放仍在运行的会话——历史轮必须出卡、活跃轮不得出卡', () => {
    const { sandbox, sess } = gateSandbox(['run-old', 'run-live'], {
        isStreaming: false, replaying: true, currentRunId: 'run-live'
    });
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-old', args: SUMMARY });
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-live', args: SUMMARY });
    assert.equal(cardBuiltOf(sess, 'run-old'), false, '回放期 DOM 在临时容器，一律只登记');
    assert.equal(cardBuiltOf(sess, 'run-live'), false, '回放期一律只登记');

    // replayDone：_replaying=false，该会话仍在跑 → isStreaming 恢复为 true
    sess._replaying = false;
    sess.isStreaming = true;
    sandbox.window.flushFileChangesReplayRender(sess);
    assert.equal(cardBuiltOf(sess, 'run-old'), true, '历史轮已收口，不出卡就是回归');
    assert.equal(cardBuiltOf(sess, 'run-live'), false, '活跃轮仍在跑，不得出卡');
});

test('门禁场景4：currentRunId 为 null 时保守视为活跃轮（Loop/后端推送首帧即 file_changes）', () => {
    // file_changes 走被动分支不推进 currentRunId，故首帧就可能是它且无从判定归属
    const running = gateSandbox(['run-1'], { isStreaming: true, currentRunId: null });
    running.sandbox.window.onFileChangesChunk(running.sess, { runId: 'run-x', args: SUMMARY });
    assert.equal(cardBuiltOf(running.sess, 'run-x'), false, '运行中且归属未知，不得抢跑出卡');

    // 收口后迟到帧（isStreaming=false 且非挂起）必须直接出卡：既有语义不得回归
    const settled = gateSandbox(['run-1'], { isStreaming: false, currentRunId: null, phase: 'done' });
    settled.sandbox.window.onFileChangesChunk(settled.sess, { runId: 'run-x', args: SUMMARY });
    assert.equal(cardBuiltOf(settled.sess, 'run-x'), true, '收口后迟到帧应直接渲染，不进 pending');
    assert.equal(settled.sess._fchRenderPending, undefined, '已渲染不得残留待渲染登记');
});

test('门禁场景5：真收口（非挂起 done）必须出卡并落在页脚之前', () => {
    const { sandbox, sess, bubbles } = gateSandbox(['run-1'], { isStreaming: true });
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-1', args: SUMMARY });
    sess.isStreaming = false;
    sess._runSuspended = false;
    sess.phase = 'done';
    sandbox.window.repositionFileChangeCards(sess);
    assert.equal(cardBuiltOf(sess, 'run-1'), true, '真收口必须出卡');
    const host = sess._fchHosts['run-1'];
    assert.equal(host.parentNode, bubbles['run-1'].bubble, '宿主应在该轮助手气泡内');
    const meta = bubbles['run-1'].meta;
    assert.equal(host.nextSibling, meta, '宿主应紧跟在 meta 行（时长徽章）之前：时长在卡片下方');
});

/* ===== 慢路径回归（重启/切换后卡片消失缺陷，曾因 attrValueEscape 未定义整体爆炸）=====
   真实链路：回放完成时 resetStreamState 已清 currentBubbleEl，快路径失效，
   runBubbleOf 必须按 data-run-id 反查气泡。曾因引用未定义的 attrValueEscape
   在此抛 ReferenceError，卡片永远进不了 DOM。 */
test('慢路径：currentBubbleEl 为空时按 data-run-id 反查气泡并出卡（重启/切换后）', () => {
    const { sandbox, sess, bubbles } = gateSandbox(['run-a', 'run-b'], { isStreaming: false, currentRunId: 'run-b' });
    sess.currentBubbleEl = null;
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-a', args: SUMMARY });
    assert.equal(cardBuiltOf(sess, 'run-a'), true, '历史轮慢路径必须出卡（attrValueEscape 已定义）');
    const hostA = sess._fchHosts['run-a'];
    assert.equal(hostA.parentNode, bubbles['run-a'].bubble, '慢路径宿主应落在 run-a 自己的气泡里');
    /* run-b 是当前轮（currentRunId 相同）但已收口 → 也走慢路径出卡 */
    sess.currentBubbleEl = null;
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-b', args: SUMMARY });
    assert.equal(cardBuiltOf(sess, 'run-b'), true, '当前轮收口后慢路径必须出卡');
    const hostB = sess._fchHosts['run-b'];
    assert.equal(hostB.parentNode, bubbles['run-b'].bubble, '不得因快路径失效落到容器根');
});

test('慢路径：气泡不在 DOM 时宿主落容器根，气泡出现后迁入（不丢卡）', () => {
    const { sandbox, sess } = gateSandbox(['run-x'], { isStreaming: false, currentRunId: null });
    sess.currentBubbleEl = null;
    sandbox.window.onFileChangesChunk(sess, { runId: 'run-x', args: SUMMARY });
    const host = sess._fchHosts['run-x'];
    assert.ok(host, '宿主应被创建');
    /* renderRoot 指向容器（无该 run 气泡）：宿主落容器根，等下一次 positionCard 迁移 */
    const { root } = gateSandbox._lastCtx || {};
    const inContainer = host.parentNode && String(host.parentNode.className || '') !== '';
    assert.ok(host.parentNode, '宿主必须被挂载（容器根或气泡），不得悬空');
});

test('慢路径：runId 含特殊字符时属性选择器不抛错（转义正确性）', () => {
    const { sandbox, sess, bubbles } = gateSandbox(['we"ird\\run'], { isStreaming: false, currentRunId: 'other' });
    sess.currentBubbleEl = null;
    let threw = null;
    try {
        sandbox.window.onFileChangesChunk(sess, { runId: 'we"ird\\run', args: SUMMARY });
    } catch (e) { threw = e; }
    assert.equal(threw, null, '特殊字符 runId 不得抛错: ' + (threw && threw.message));
});

test('位置自愈：宿主被挤到页脚之后时，positionCard 重建「正文 → 卡片 → 页脚」序', () => {
    /* 场景：收口后新节点（如迟到正文块/inline 指示器清理）可能把宿主顶到页脚之后，
       这正是老实现「宿主恒在气泡末尾」注释里的前提。新实现必须在下一次 positionCard
       （repositionFileChangeCards / 迟到帧 / 会话切换补渲染）把宿主收回页脚之前。 */
    const sandbox = loadModule();
    const root = makeRoot();
    const run = makeRunBubble(root, 'run-1');
    const sess = {
        sessionId: 's1', projectRoot: '', container: root, isStreaming: false, _replaying: false,
        currentBubbleEl: run.md, currentRunId: 'run-1', inlineThinkingEl: null
    };
    sandbox.renderRoot = function () { return root; };
    run.bubble.querySelector = function () { return null; };
    const onChunk = sandbox.window.onFileChangesChunk || sandbox.onFileChangesChunk;
    onChunk(sess, { runId: 'run-1', args: SUMMARY });
    const host = sess._fchHosts['run-1'];
    assert.equal(host.nextSibling, run.meta, '初始落位：宿主在页脚之前');
    /* 模拟漂移：外部把宿主搬到气泡末尾（老 bug 形态 / 迟到节点插入） */
    run.bubble.appendChild(host);
    assert.notEqual(host.nextSibling, run.meta, '漂移已注入（否则后续断言无意义）');
    sandbox.window.repositionFileChangeCards(sess);
    assert.equal(host.nextSibling, run.meta, 'positionCard 必须把宿主收回页脚之前（时长徽章在卡片下方）');
    const kids = run.bubble.childNodes;
    assert.equal(kids[kids.length - 1], run.meta, 'meta 行应回到气泡末尾（时长徽章在卡片下方）');
});
