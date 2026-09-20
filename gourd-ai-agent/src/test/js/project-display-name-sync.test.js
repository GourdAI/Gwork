/**
 * 契约测试：项目「显示名」跨视图一致与即时同步（方案 C）。
 *
 * 背景（实机 bug）：项目重命名只改 projects.json 的 name、不动磁盘目录，
 * 而欢迎页工作空间选择器按钮走 baseName(路径) 取名，导致重命名后
 * 「侧栏 gost-test / 欢迎页按钮 gost」永久不一致（刷新重启都不会好）；
 * 记忆页与自动化页则因持有项目列表副本、缺少改名广播，打开着时名字停在旧值。
 *
 * 本测试锁定：
 * - 取名口径：凡展示项目名处一律「登记名优先、未登记回退目录名」，
 *   不得直接用 baseName(路径) 作为最终显示名
 * - 同步机制：projects.json 变更（重命名/新增/移除）统一经 window.notifyProjectsChanged()
 *   派发 'projects:changed'，各持有列表副本的视图监听后重拉刷新
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');

function readJs(name) {
    return fs.readFileSync(path.join(staticRoot, 'js', name), 'utf8').replace(/^\uFEFF/, '');
}
function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

const base = readJs('app-base.js');
const workspace = readJs('app-workspace.js');
const history = readJs('app-history.js');
const memory = readJs('app-memory.js');
const automation = readJs('app-automation.js');

// ====================================================================
// 广播接缝
// ====================================================================

test('app-base：暴露 notifyProjectsChanged 并派发 projects:changed 事件', () => {
    const fn = sliceBetween(base, 'function notifyProjectsChanged()', 'window.notifyProjectsChanged = notifyProjectsChanged;');
    assert.match(fn, /dispatchEvent\(new CustomEvent\('projects:changed'\)\)/);
    assert.match(base, /window\.notifyProjectsChanged = notifyProjectsChanged;/);
});

test('侧栏重命名成功后广播 projects:changed（否则其它视图停在旧名字）', () => {
    const fn = sliceBetween(history, 'function updateProjectDisplayName(path, name)', 'function deleteSession(');
    // 本地改名 + 刷新侧栏（原有行为）
    assert.match(fn, /_sidebarData\.projects\[i\]\.name = name;/);
    assert.match(fn, /updateHistoryUI\(\);/);
    // 广播（新增行为）：带 typeof 守卫，兼容脚本加载顺序
    assert.match(fn, /typeof window\.notifyProjectsChanged === 'function'/);
    assert.match(fn, /window\.notifyProjectsChanged\(\);/);
});

test('欢迎页选择器的新增/移除登记同样广播（列表增删对其它视图可见）', () => {
    const delegate = sliceBetween(workspace, "document.addEventListener('click'", 'function boot()');
    const calls = delegate.match(/window\.notifyProjectsChanged\(\)/g) || [];
    assert.ok(calls.length >= 2, '新增与移除两条路径都应广播 projects:changed');
});

// ====================================================================
// 取名口径：登记名优先
// ====================================================================

test('欢迎页工作空间按钮用登记名（不得回归 baseName(currentChatWorkspace)）', () => {
    const fn = sliceBetween(workspace, 'function displayName()', '/* 拉取登记项目列表');
    assert.match(fn, /return nameOf\(window\.currentChatWorkspace\);/);
    assert.doesNotMatch(
        fn,
        /return baseName\(window\.currentChatWorkspace\);/,
        '按钮显示名不得直接取路径末段：重命名只改登记名，baseName 永远读不到新名字'
    );
    // nameOf：查登记表命中取 name，未命中回退目录名
    const nameOf = sliceBetween(workspace, 'function nameOf(path)', 'function displayName()');
    assert.match(nameOf, /projectsCache/);
    assert.match(nameOf, /return p\.name;/);
    assert.match(nameOf, /return baseName\(path\);/, '未登记路径应回退目录名');
});

test('欢迎页：按钮与下拉列表同源（统一经 loadProjects 刷新 projectsCache）', () => {
    assert.match(workspace, /var projectsCache = \[\];/);
    const loader = sliceBetween(workspace, 'function loadProjects(cb)', 'function renderSelectors()');
    assert.match(loader, /\$\.get\('\/web\/chat\/projects'/);
    assert.match(loader, /projectsCache = \[\];/);
    assert.match(loader, /renderSelectors\(\);/, '列表刷新后须同步重绘按钮文案');
    // 下拉渲染不得再自行发请求（双数据源会出现「列表新名/按钮旧名」）
    const dropdown = sliceBetween(workspace, 'function renderDropdown(dd)', '/* 切换 chat 工作空间');
    assert.match(dropdown, /loadProjects\(function \(list\)/);
    assert.doesNotMatch(dropdown, /\$\.get\('\/web\/chat\/projects'/, '下拉应复用 loadProjects，不得另开数据源');
});

test('自动化任务卡的工作空间标签用登记名（不得回归 baseName(x.workspace)）', () => {
    const card = sliceBetween(automation, 'function taskCardHtml(x)', 'function showForm(');
    assert.match(card, /projectNameOf\(x\.workspace\)/);
    assert.doesNotMatch(card, /baseName\(x\.workspace\)/, '任务卡标签不得直接取路径末段');
    // projectNameOf：登记名优先、回退目录名
    const fn = sliceBetween(automation, 'function projectNameOf(path)', '/** 未选 = 全局');
    assert.match(fn, /formState\.projects\[i\]\.name \|\| baseName\(path\)/);
    assert.match(fn, /return baseName\(path\);/);
    // 表单按钮文案复用同一函数，避免两套口径
    const label = sliceBetween(automation, 'function workspaceLabel()', '/** 历史档位值归一');
    assert.match(label, /return projectNameOf\(formState\.workspace\);/);
});

test('自动化列表渲染前先备齐登记项目列表（否则首屏标签回退目录名）', () => {
    const fn = sliceBetween(automation, 'function showList()', 'function taskCardHtml(x)');
    const loadIdx = fn.indexOf('loadProjects(function ()');
    const apiIdx = fn.indexOf("api('list'");
    assert.ok(loadIdx >= 0, 'showList 应先加载项目列表');
    assert.ok(apiIdx > loadIdx, '任务列表请求应位于 loadProjects 回调之内');
});

// ====================================================================
// 监听方：改名后即时刷新
// ====================================================================

test('欢迎页选择器监听 projects:changed 并重拉列表', () => {
    assert.match(
        workspace,
        /document\.addEventListener\('projects:changed', function \(\) \{ loadProjects\(\); \}\);/
    );
});

test('记忆页监听 projects:changed 重拉项目（仅在视图打开时请求）', () => {
    const listener = sliceBetween(
        memory,
        "document.addEventListener('projects:changed'",
        "document.addEventListener('i18n:localeChanged'"
    );
    assert.match(listener, /if \(!\$view\.hasClass\('active'\)\) return;/, '未打开时不应发起请求');
    assert.match(listener, /loadMemoryProjects\(\);/);
});

test('自动化页监听 projects:changed：作废缓存后重拉并按当前页面重绘', () => {
    const listener = sliceBetween(
        automation,
        "document.addEventListener('projects:changed'",
        'window.openAutomation = openAutomation;'
    );
    // 必须作废 projectsLoaded，否则 loadProjects 命中缓存直接返回旧名字
    assert.match(listener, /formState\.projectsLoaded = false;/);
    assert.match(listener, /loadProjects\(function \(\)/);
    assert.match(listener, /if \(!\$\('#automationView'\)\.hasClass\('active'\)\) return;/);
    assert.match(listener, /if \(formMode\) renderWorkspaceUI\(\);/);
    assert.match(listener, /else showList\(\);/);
});

// ====================================================================
// 语法护栏
// ====================================================================

test('改动文件语法合法且行尾未被破坏（无裸 LF 混入 CRLF 文件）', () => {
    for (const name of ['app-base.js', 'app-workspace.js', 'app-history.js', 'app-memory.js', 'app-automation.js']) {
        const raw = fs.readFileSync(path.join(staticRoot, 'js', name), 'latin1');
        const lines = raw.split('\n');
        const crlf = lines.filter((l, i) => i < lines.length - 1 && l.endsWith('\r')).length;
        const bare = lines.filter((l, i) => i < lines.length - 1 && !l.endsWith('\r')).length;
        assert.ok(crlf === 0 || bare === 0, `${name} 行尾混用：CRLF=${crlf}, bareLF=${bare}`);
        assert.ok(!raw.startsWith('\uFEFF'), `${name} 不应带 BOM`);
    }
});

// 行为回归：执行完整生产脚本，仅替身化浏览器、jQuery、模型组件和网络边界。
// html() 重建主容器时丢弃旧节点，确保错误的 showList/showForm 不能伪装成保留草稿。
function automationHarness() {
    const nodes = new Map();
    const listeners = new Map();
    const clicks = new Map();
    const requests = [];
    const counts = { rootWrites: 0, creates: 0, destroys: 0 };
    let selectorOptions;
    const selectHandlers = new Map();
    function element(id) {
        if (!nodes.has(id)) nodes.set(id, {
            id, value: '', text: '', html: '', attrs: {}, props: {}, classes: new Set(),
            style: {}, scrollHeight: 92
        });
        return nodes.get(id);
    }
    function wrap(el) {
        const q = {
            length: el ? 1 : 0,
            val(v) { if (v === undefined) return el && el.value; if (el) el.value = v; return q; },
            text(v) { if (v === undefined) return el && el.text; if (el) el.text = v; return q; },
            attr(k, v) { if (v === undefined) return el && el.attrs[k]; if (el) el.attrs[k] = v; return q; },
            prop(k, v) { if (v === undefined) return el && el.props[k]; if (el) el.props[k] = v; return q; },
            data(k) { return el && el.attrs['data-' + k]; },
            html(v) {
                if (v === undefined) return el && el.html;
                if (!el) return q;
                el.html = v;
                if (el.id === 'automationInner') {
                    counts.rootWrites++;
                    for (const id of nodes.keys()) if (id.startsWith('auto') && !id.startsWith('automation')) nodes.delete(id);
                    for (const match of v.matchAll(/id="([^"]+)"/g)) element(match[1]);
                }
                return q;
            },
            hasClass(k) { return !!el && el.classes.has(k); },
            addClass(k) { if (el) el.classes.add(k); return q; },
            removeClass(k) { if (el) el.classes.delete(k); return q; },
            toggleClass(k, on) {
                if (el) { if (on === undefined) on = !el.classes.has(k); if (on) el.classes.add(k); else el.classes.delete(k); }
                return q;
            },
            show() { return q; }, hide() { return q; },
            is(k) { return k === ':checked' && !!el && !!el.props.checked; },
            on(event, selector, fn) { if (typeof selector === 'string') clicks.set(event + ':' + selector, fn); return q; },
            find(selector) {
                // 保存测试使用真实 cron 分支；调度内容本身仍由生产 buildCron 读取。
                if (selector === '.loop-schedule-tab.active') return wrap({ attrs: { 'data-sched': 'cron' } });
                return wrap(null);
            },
            each() { return q; }
        };
        return q;
    }
    for (const id of ['automationInner', 'automationView', 'welcomeView', 'chatView', 'automationNavBtn', 'settingsOverlay']) element(id);
    function $(selector) {
        if (typeof selector !== 'string') return wrap(selector);
        return wrap(nodes.get(selector.slice(1)) || null);
    }
    $.extend = Object.assign;
    $.ajax = options => requests.push(options);
    $.get = (url, success) => {
        const request = { url, success };
        requests.push(request);
        return { fail(fn) { request.error = fn; } };
    };
    const document = {
        addEventListener(name, fn) { listeners.set(name, fn); },
        getElementById(id) { return nodes.get(id) || null; }
    };
    const window = { SESSION_ID: 'session-test' };
    vm.runInNewContext(automation, {
        window, document, $, console,
        layui: { form: { render() {}, on(name, fn) { selectHandlers.set(name, fn); } } },
        GourdModelDropdown: { searchHtml() { return ''; } },
        GourdModelSelector: {
            create(options) { selectorOptions = options; counts.creates++; return { update() {}, destroy() { counts.destroys++; } }; },
            thinkingOptionsFor() { return [{ value: 'high' }]; }
        }
    }, { filename: 'app-automation.js' });
    function take(suffix) {
        const i = requests.findIndex(r => r.url.endsWith('/' + suffix));
        assert.ok(i >= 0, '缺少请求: ' + suffix);
        return requests.splice(i, 1)[0];
    }
    function reply(suffix, data) { take(suffix).success({ code: 200, data }); }
    function click(selector, attrs = {}) {
        const fn = clicks.get('click:' + selector);
        assert.equal(typeof fn, 'function', '缺少真实委托: ' + selector);
        fn.call({ attrs }, { stopPropagation() {} });
    }
    function projects(name = '旧登记名') { return [{ path: '/work/repo', name }]; }
    function start() {
        window.openAutomation();
        reply('projects', projects());
        reply('list', [{ id: 'task-1', workspace: '/work/repo', name: '原任务', prompt: '原指令' }]);
    }
    function openForm(edit) {
        if (edit) {
            click('.auto-act', { 'data-action': 'edit', 'data-id': 'task-1' });
            reply('get', { name: '保存过的名称', prompt: '保存过的指令', workspace: '/work/repo' });
        } else click('#autoAddBtn');
        if (requests.some(r => r.url.endsWith('/models'))) reply('models', { list: [], selected: '' });
    }
    const draftValues = { autoName: '未保存标题', autoPrompt: '未保存指令\n第二行', autoCron: '0 15 8 * * ?', autoDailyTime: '18:35', autoInterval: '7', autoMaxIter: '13' };
    function draft() {
        for (const [id, value] of Object.entries(draftValues)) $('#' + id).val(value);
        $('#autoWorktree').prop('checked', true);
        click('#autoWsDropdown .auto-ws-item', { 'data-path': '/work/repo' });
        selectorOptions.onSelect('draft-model');
        selectorOptions.thinking.onChange('high');
        selectorOptions.context.onChange('128K');
        selectHandlers.get('select(autoChannel)')({ value: 'feishu' });
        selectHandlers.get('select(autoIntervalUnit)')({ value: 'h' });
        return { counts: { ...counts }, refs: Object.fromEntries(Object.keys(draftValues).map(id => [id, nodes.get(id)])) };
    }
    function assertDraft(before, edit, renamed = true) {
        assert.deepEqual(counts, before.counts, '不得重建主容器或销毁/重建模型选择器');
        for (const [id, value] of Object.entries(draftValues)) {
            assert.equal(nodes.get(id), before.refs[id], id + ' 节点被替换');
            assert.equal($('#' + id).val(), value, id + ' 草稿被修改');
        }
        assert.equal($('#autoWorktree').prop('checked'), true);
        assert.equal($('#autoWsName').attr('title'), '/work/repo');
        if (renamed) {
            assert.equal($('#autoWsName').text(), '新登记名');
            assert.match($('#autoWsDropdown').html(), /新登记名/);
            assert.ok($('#autoWsDropdown').html().includes('auto-ws-item active" data-path="/work/repo"'));
        }
        assert.equal(requests.filter(r => r.url.endsWith('/list') || r.url.endsWith('/get')).length, 0, '表单改名不得重拉任务');
        // 经真实 doSave 读取闭包选择值，证明改名未悄悄改变保存路径、模型与草稿。
        click('#autoSaveBtn');
        const params = take(edit ? 'update' : 'add').data;
        for (const [key, value] of Object.entries({ taskWorkspace: '/work/repo', name: draftValues.autoName, prompt: draftValues.autoPrompt, cron: draftValues.autoCron, modelName: 'draft-model', thinkingDepth: 'high', contextLength: '128K', channelNotify: 'feishu', maxIterations: 13, worktreeEnabled: true })) assert.equal(params[key], value, key);
        assert.equal(params.taskId, edit ? 'task-1' : undefined);
    }
    return { window, $, counts, requests, start, openForm, draft, assertDraft, projects, reply, take, click,
        changed() { listeners.get('projects:changed')(); } };
}

for (const edit of [false, true]) {
    const mode = edit ? '编辑' : '新建';
    test('自动化行为：' + mode + '改名仅刷新名称，保留节点、草稿和保存参数', () => {
        const h = automationHarness();
        h.start(); h.openForm(edit);
        const before = h.draft();
        h.changed(); h.reply('projects', h.projects('新登记名'));
        h.assertDraft(before, edit);
    });
    test('自动化行为：改名重拉期间列表切到' + mode + '，回调读取当前模式', () => {
        const h = automationHarness();
        h.start(); h.changed();
        h.openForm(edit);
        const before = h.draft();
        h.reply('projects', h.projects('新登记名'));
        // showForm 在缓存失效期间也有自己的项目请求。
        h.reply('projects', h.projects('新登记名'));
        h.assertDraft(before, edit);
    });
    test('自动化行为：列表响应迟到不得覆盖刚打开的' + mode + '表单', () => {
        const h = automationHarness();
        h.start(); h.changed(); h.reply('projects', h.projects('新登记名'));
        const pendingList = h.take('list');
        h.openForm(edit);
        const before = h.draft();
        pendingList.success({ code: 200, data: [] });
        h.assertDraft(before, edit);
    });
}

test('自动化行为：列表态改名正常重拉并渲染新任务卡标签', () => {
    const h = automationHarness(); h.start();
    assert.match(h.$('#automationInner').html(), /旧登记名/);
    const writes = h.counts.rootWrites;
    h.changed(); h.reply('projects', h.projects('新登记名'));
    h.reply('list', [{ id: 'task-1', workspace: '/work/repo', name: '原任务' }]);
    assert.equal(h.counts.rootWrites, writes + 1);
    assert.match(h.$('#automationInner').html(), /auto-task-tag">新登记名/);
    assert.doesNotMatch(h.$('#automationInner').html(), /旧登记名/);
});

test('自动化行为：showList 等项目加载时打开表单，不再发出列表请求', () => {
    const h = automationHarness(); h.start(); h.openForm(false);
    h.changed();
    const renameRequest = h.take('projects');
    h.click('#autoBackBtn');
    const listProjects = h.take('projects');
    h.openForm(false);
    const before = h.draft();
    listProjects.success({ data: h.projects('新登记名') });
    renameRequest.success({ data: h.projects('新登记名') });
    h.reply('projects', h.projects('新登记名'));
    h.assertDraft(before, false);
});

test('自动化行为：改名重拉期间表单返回列表，仍正常刷新列表', () => {
    const h = automationHarness(); h.start(); h.openForm(false); h.changed();
    h.click('#autoBackBtn');
    h.reply('projects', h.projects('新登记名'));
    h.reply('projects', h.projects('新登记名'));
    while (h.requests.some(r => r.url.endsWith('/list'))) h.reply('list', [{ id: 'task-1', workspace: '/work/repo' }]);
    assert.match(h.$('#automationInner').html(), /auto-task-tag">新登记名/);
});
