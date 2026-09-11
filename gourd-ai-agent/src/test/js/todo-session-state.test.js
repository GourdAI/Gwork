const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function element() {
    return {
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        addEventListener() {},
        closest() { return null; },
        textContent: '',
        innerHTML: ''
    };
}

function createContext() {
    const elements = {};
    for (const id of [
        'todoBadge', 'todoList', 'todoEmpty', 'todoStats', 'todoRefreshBtn',
        'chatTodoChipWrap', 'chatTodoChip', 'chatTodoPanel'
    ]) elements[id] = element();

    const requests = [];
    const context = {
        console,
        Promise,
        encodeURIComponent,
        setTimeout,
        clearTimeout,
        SESSION_ID: 'session-a',
        sessionMap: {
            'session-a': { projectRoot: 'D:\\workspace-a' },
            'session-b': { projectRoot: 'D:\\workspace-b' }
        },
        document: {
            getElementById(id) { return elements[id] || null; },
            addEventListener() {}
        },
        GourdI18n: { t(key) { return key; } },
        getSessionCwd() { return 'D:\\wrong-global-root'; },
        updateHistoryUI() {},
        fetch(url, options) {
            const pending = deferred();
            requests.push({ url, options, pending });
            return pending.promise;
        }
    };
    context.window = context;
    context.window.sessionTodoMap = {};
    context.window._todoChipVisible = true;
    context.window.updateChipWrapVisibility = function() {};

    const source = fs.readFileSync(path.join(staticRoot, 'js/app-todos.js'), 'utf8').replace(/^\uFEFF/, '');
    vm.runInNewContext(source, context, { filename: 'app-todos.js' });
    return { context, elements, requests };
}

function respond(request, data) {
    request.pending.resolve({ json() { return Promise.resolve({ data }); } });
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('任务查询优先使用会话保存的 projectRoot，而不是当前全局工作区', async () => {
    const { context, requests } = createContext();

    const loading = context.window.loadTodos('session-a');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/web/chat/todos?sessionId=session-a');
    assert.equal(requests[0].options.headers['X-Session-Cwd'], 'D:\\workspace-a');

    respond(requests[0], { exists: false, items: [], stats: {} });
    await loading;
});

test('旧会话空响应不得清空当前会话任务状态或隐藏任务按钮', async () => {
    const { context, elements, requests } = createContext();
    context.window.sessionTodoMap = {
        'session-a': { done: 0, total: 2 },
        'session-b': { done: 1, total: 3 }
    };
    elements.chatTodoChip.style.display = '';

    const loadingA = context.window.loadTodos('session-a');
    context.SESSION_ID = 'session-b';
    respond(requests[0], { exists: false, items: [], stats: { total: 0 } });
    await loadingA;

    assert.equal(context.window.sessionTodoMap['session-a'], undefined);
    assert.deepEqual(context.window.sessionTodoMap['session-b'], { done: 1, total: 3 });
    assert.equal(context.window._todoChipVisible, true);
    assert.equal(elements.chatTodoChip.style.display, '');
});

test('同一会话较旧的空响应不得覆盖较新的非空任务结果', async () => {
    const { context, elements, requests } = createContext();

    const older = context.window.loadTodos('session-a');
    const newer = context.window.loadTodos('session-a');
    assert.equal(requests.length, 2);

    respond(requests[1], {
        exists: true,
        raw: '- [/] 修复任务状态',
        items: [{ status: 'in_progress', text: '修复任务状态', group: '' }],
        stats: { total: 1, done: 0, inProgress: 1, pending: 0 }
    });
    await newer;

    respond(requests[0], { exists: false, items: [], stats: { total: 0 } });
    await older;
    await flushPromises();

    assert.equal(context.window.sessionTodoMap['session-a'].done, 0);
    assert.equal(context.window.sessionTodoMap['session-a'].total, 1);
    assert.equal(context.window._todoChipVisible, true);
    assert.equal(elements.chatTodoChip.style.display, '');
    assert.match(elements.todoList.innerHTML, /修复任务状态/);
});

test('流结束与会话切换刷新均显式传入目标 sessionId 和 projectRoot', () => {
    const source = fs.readFileSync(path.join(staticRoot, 'js/app-streaming.js'), 'utf8').replace(/^\uFEFF/, '');
    assert.match(source, /window\.loadTodos\(sess\.sessionId, sess\.projectRoot\)/);
    assert.match(source, /window\.loadTodos\(sid, todoSess \? todoSess\.projectRoot : ''\)/);
    assert.doesNotMatch(source, /if \(window\.loadTodos\) window\.loadTodos\(\);/);
});
