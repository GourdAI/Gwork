const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');

function read(rel) {
    return fs.readFileSync(path.join(staticRoot, rel), 'utf8').replace(/^\uFEFF/, '');
}

const html = read('memory.html');
const source = read('js/app-memory.js');
const css = read('css/memory-view.css');

function functionBlock(name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, `${name} source not found`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`${name} closing brace not found`);
}

test('记忆页提供独立项目选择器并显示项目名称和完整路径', () => {
    for (const id of [
        'memoryProjectSelector',
        'memoryProjectCurrent',
        'memoryProjectName',
        'memoryProjectPath',
        'memoryProjectDropdown'
    ]) {
        assert.match(html, new RegExp(`id=["']${id}["']`), `缺少 ${id}`);
    }
    assert.match(html, /class="memory-project-current-name"/);
    assert.match(html, /class="memory-project-current-path"/);
    assert.match(css, /\.memory-project-selector\s*\{/);
    assert.match(css, /\.memory-project-option-path\s*\{/);
    assert.match(css, /text-overflow:\s*ellipsis/);
    assert.match(css, /@media \(max-width:\s*680px\)/);
});

test('项目列表只来自登记项目接口，选择结果只写入记忆页局部状态', () => {
    assert.match(source, /fetch\('\/web\/chat\/projects'\)/);
    assert.match(source, /var memorySelectedCwd = '';/);
    assert.match(source, /memorySelectedCwd = path;/);
    assert.match(source, /memoryProjects = \(Array\.isArray\(res\.data\) \? res\.data : \[\]\)\.filter/);
    assert.doesNotMatch(source, /function defaultWorkspace\(/);

    for (const forbidden of [
        /window\.currentProjectRoot\s*=/,
        /window\.currentChatWorkspace\s*=/,
        /selectProject\s*\(/,
        /selectChatWorkspace\s*\(/,
        /applyChatWorkspace\s*\(/,
        /dispatchEvent\s*\([^)]*workspace:changed/
    ]) {
        assert.doesNotMatch(source, forbidden);
    }
    assert.doesNotMatch(html, /workspace-selector|workspace-dropdown|project-dropdown-item/);
});

test('工作空间请求使用局部项目路径，全局请求明确忽略项目路径', () => {
    const snapshot = functionBlock('scopeSnapshot');
    const headers = functionBlock('sessionHeaders');
    const guardedLoad = functionBlock('loadMemories');
    const readyLoad = functionBlock('loadWorkspaceMemoriesWhenReady');
    const canOperate = functionBlock('canOperateSnapshot');
    assert.match(snapshot, /currentScope === SCOPE_WORKSPACE \? memorySelectedCwd : ''/);
    assert.match(headers, /headers\['X-Session-Cwd'\] = cwdSnapshot/);
    assert.match(guardedLoad, /if \(!canOperateSnapshot\(snapshot\)\) return;/);
    assert.match(canOperate, /memoryProjectsLoaded && !!snapshot\.cwd && !!registeredProject\(snapshot\.cwd\)/);
    assert.match(readyLoad, /if \(!memoryProjectsLoaded\)/);
    assert.doesNotMatch(headers, /getSessionCwd/);

    assert.match(source, /headers:\s*sessionHeaders\(snapshot\.cwd\)/);
    assert.match(source, /var headers = sessionHeaders\(snapshot\.cwd\);/);
    assert.match(source, /body: JSON\.stringify\(\{ scope: snapshot\.scope, key: key \}\)/);
    assert.match(source, /body: JSON\.stringify\(\{ scope: snapshot\.scope \}\)/);
});

test('首次打开仅继承当前应用目录，后续不再跟随 workspace changed', () => {
    const initialize = functionBlock('initializeMemoryWorkspace');
    assert.match(initialize, /if \(memorySelectionInitialized\) return;/);
    assert.match(initialize, /window\.getSessionCwd\(\)/);
    assert.doesNotMatch(source, /addEventListener\('workspace:changed'/);
});

test('项目和记忆异步请求都有序列与快照门禁，旧响应及旧确认不会操作新空间', () => {
    assert.match(source, /var requestSeq = \+\+projectsRequestSeq;/);
    assert.match(source, /if \(requestSeq !== projectsRequestSeq\) return;/);
    assert.match(source, /var requestSeq = \+\+listRequestSeq;/);
    assert.match(source, /requestSeq !== listRequestSeq \|\| !isCurrentSnapshot\(snapshot\)/);
    assert.match(source, /lastListSnapshot = snapshot;/);
    assert.match(source, /lastListSnapshot && isCurrentSnapshot\(lastListSnapshot\)/);
    assert.equal((source.match(/if \(!isCurrentSnapshot\(snapshot\) \|\| !canOperateSnapshot\(snapshot\)\) return;/g) || []).length, 2);
});

test('路径比较统一 Windows 分隔符且保留 POSIX 大小写', () => {
    const pathKey = Function(functionBlock('pathKey') + '; return pathKey;')();
    assert.equal(pathKey('D:\\Work\\Demo\\'), 'd:\\work\\demo');
    assert.equal(pathKey('d:/work/demo'), 'd:\\work\\demo');
    assert.equal(pathKey('/work/Foo/'), '/work/Foo');
    assert.notEqual(pathKey('/work/Foo'), pathKey('/work/foo'));
});

test('记忆模块可独立解析', () => {
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'app-memory.js' }));
});
