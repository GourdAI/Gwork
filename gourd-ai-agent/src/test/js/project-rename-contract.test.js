/**
 * 契约测试：侧栏项目行「重命名显示名」（方案 A）。
 *
 * 背景：项目列表按目录命名，同名不同目录（如两个 wx-paas-platform）在侧栏无法区分，
 * 需要支持修改显示名（仅改展示名，不动磁盘目录与路径）。本测试锁定前后端契约：
 * - 后端：ProjectService.rename 原地改名（保持列表顺序、空名恢复目录名）；
 *   WebController 暴露 POST /web/chat/projects/rename
 * - 前端：项目行渲染重命名按钮（i18n 标题）；点击委托分支位于展开/收起分支之前；
 *   startProjectRename 原位编辑（blur/Enter 提交、Esc 取消）、成功后本地刷新
 * - i18n：12 个语言包均提供 app.sidebar.rename_project / rename_failed（JSON 合法、行尾无裸 LF）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java');
const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

function readStatic(...segs) {
    return fs.readFileSync(path.join(staticRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}
function readJava(...segs) {
    return fs.readFileSync(path.join(javaRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}
function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

const history = readStatic('js', 'app-history.js');

// ====================================================================
// 后端契约
// ====================================================================

test('后端：ProjectService.rename 原地改名（保持顺序、不置顶）', () => {
    const src = readJava('com/gourdai/core/portal/web/ProjectService.java');
    const fn = sliceBetween(src, 'public Result<List<Map>> rename(String path, String name)', '// ==================== 内部');
    // 原地修改：不得复用 add 的置顶逻辑（removeIf + add(0)），否则「最近使用」排序被改名动作污染
    assert.doesNotMatch(fn, /projects\.add\(0,/, 'rename 不应把项目置顶（不得复用 add 逻辑）');
    assert.doesNotMatch(fn, /removeIf/, 'rename 不应移除加回（应原地改 name）');
    assert.match(fn, /target\.put\("name", displayName\)/);
    // 空名恢复为目录名
    assert.match(fn, /name\.trim\(\)\.isEmpty\(\)/);
    assert.match(fn, /dir\.getFileName\(\)/);
    // 参数校验与未登记 404
    assert.match(fn, /Result\.failure\(400, "Path is required"\)/);
    assert.match(fn, /Result\.failure\(400, "Invalid path"\)/);
    assert.match(fn, /Result\.failure\(404, "Project not found"\)/);
});

test('后端：WebController 暴露 POST /web/chat/projects/rename', () => {
    const src = readJava('com/gourdai/core/portal/web/WebController.java');
    const fn = sliceBetween(src, '@Mapping("/web/chat/projects/rename")', '// ==================== 消息队列管理');
    assert.match(fn, /@Mapping\("\/web\/chat\/projects\/rename"\)/);
    assert.match(fn, /name = json\.get\("name"\)\.getString\(\);/);
    assert.match(fn, /return projectService\.rename\(path, name\);/);
});

// ====================================================================
// 前端契约（app-history.js）
// ====================================================================

test('前端：项目行渲染重命名按钮（proj-rename + i18n 标题，排在移除按钮之前）', () => {
    const node = sliceBetween(history, 'function projNodeHtml(', '/* Sidebar event delegation');
    assert.match(node, /proj-action-btn proj-rename/);
    assert.match(node, /app\.sidebar\.rename_project/);
    // 铅笔图标（与会话重命名同款路径）
    assert.ok(
        node.includes('M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'),
        '重命名按钮缺少铅笔图标路径'
    );
    const renameIdx = node.indexOf('proj-rename');
    const removeIdx = node.indexOf('proj-remove');
    assert.ok(renameIdx >= 0 && removeIdx >= 0, 'projNodeHtml 应同时包含重命名与移除按钮');
    assert.ok(renameIdx < removeIdx, '重命名按钮应排在移除按钮之前（避免误触移除）');
});

test('前端：点击委托——重命名分支位于展开/收起分支之前，且输入框点击不触发折叠', () => {
    const delegate = sliceBetween(history, "$(historyList).on('click'", 'window.startNewChatInWorkspace = function');
    // 分支顺序：重命名必须先于展开/收起（避免被吸收后触发展开切换）
    const renameIdx = delegate.indexOf("var $projRename = $target.closest('.proj-rename');");
    const nodeIdx = delegate.indexOf("var $proj = $target.closest('.proj-node');");
    assert.ok(renameIdx >= 0, '缺少项目行重命名分支');
    assert.ok(nodeIdx >= 0, '缺少项目行展开/收起分支');
    assert.ok(renameIdx < nodeIdx, '重命名分支必须位于展开/收起分支之前');
    // 分支内：命中后调用 startProjectRename 并 return（不再落入后续分支）
    const branch = sliceBetween(delegate, "var $projRename = $target.closest('.proj-rename');", '// 项目行「从列表移除」');
    assert.match(branch, /if \(rnp\) startProjectRename\(rnp\);\s*return;/);
    // 展开/收起分支：重命名输入框上的点击直接返回（列表重建会打断编辑）
    assert.match(delegate, /if \(\$target\.closest\('\.sidebar-rename-input'\)\.length\) return;/);
});

test('前端：startProjectRename 原位编辑（blur/Enter 提交、Esc 取消、空值取消）', () => {
    const fn = sliceBetween(history, 'function startProjectRename(path)', '/* 项目显示名本地更新');
    // 提交目标与参数（与会话重命名一致的交互，接口走专用 rename 端点）
    assert.match(fn, /\$\.post\('\/web\/chat\/projects\/rename', \{ path: path, name: newName \}\)/);
    // 空值 / 未变更不提交（关闭输入框即取消）
    assert.match(fn, /if \(newName && newName !== currentName\)/);
    // 成功 → 本地刷新；失败 → toast（done 的 else 与 fail 两条路径）
    assert.match(fn, /updateProjectDisplayName\(path, newName\)/);
    const failToast = fn.match(/rename_failed/g) || [];
    assert.ok(failToast.length >= 2, '失败提示应覆盖 done(非200) 与 fail 两条路径');
    // 交互：maxlength 限制、blur 提交、Enter 确认、Esc 恢复
    assert.match(fn, /maxlength: 50/);
    assert.match(fn, /\$input\.on\('blur', finishProjectRename\)/);
    assert.match(fn, /e\.key === 'Enter'/);
    assert.match(fn, /e\.key === 'Escape'/);
    assert.match(fn, /val: currentName/);
});

test('前端：updateProjectDisplayName 更新 _sidebarData 并刷新侧栏', () => {
    const fn = sliceBetween(history, 'function updateProjectDisplayName(path, name)', 'function deleteSession(');
    assert.match(fn, /_sidebarData\.projects\[i\]\.name = name;/);
    assert.match(fn, /updateHistoryUI\(\);/);
});

// ====================================================================
// i18n：12 个语言包
// ====================================================================

test('i18n：12 个语言包均提供 rename_project / rename_failed（JSON 合法、行尾无裸 LF）', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        assert.equal(typeof json.app.sidebar.rename_project, 'string', `${lang} 缺少 app.sidebar.rename_project`);
        assert.equal(typeof json.app.sidebar.rename_failed, 'string', `${lang} 缺少 app.sidebar.rename_failed`);
        assert.ok(json.app.sidebar.rename_project.trim().length > 0, `${lang} 的 rename_project 为空`);
        const latin = fs.readFileSync(path.join(staticRoot, 'locales', `${lang}.json`), 'latin1');
        const loneLf = latin.split('\n').filter((line, i, arr) => i < arr.length - 1 && !line.endsWith('\r')).length;
        assert.equal(loneLf, 0, `${lang}.json 存在裸 LF 行，行尾被破坏`);
    }
});
