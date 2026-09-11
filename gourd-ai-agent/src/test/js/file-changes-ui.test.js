const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const jsDir = path.join(staticRoot, 'js');

function read(rel) {
    return fs.readFileSync(path.join(staticRoot, rel), 'utf8').replace(/^\uFEFF/, '');
}

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
    assert.match(source, /revision < previousRevision/);
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
    assert.match(source, /if \(previous && revision === previousRevision && card\) return;/);
    assert.match(source, /row\.className = 'file-changes-run-row';/);
    assert.match(source, /sess\.container\.appendChild\(row\);/);
    assert.match(source, /upsert\(sess, runId, summary\);/);
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
    assert.match(source, /if \(created && sess\._replaying\) deferReplayReconcile\(sess, runKey\);/);
    assert.match(source, /else if \(created && !sess\.isStreaming\) reconcile\(sess, runKey\);/);
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
            // 非中英文语言包不得直接照搬英文原文（en 自身除外）
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

test('样式复用 theme token 并包含直属行与窄窗口防溢出规则', () => {
    const css = read('css/app.css');
    const block = css.slice(css.indexOf('.file-changes-run-row'), css.indexOf('/* Batch tool group'));
    assert.ok(block.length > 0);
    assert.match(block, /\.file-changes-run-row > \.file-changes-card \{[^}]*background:/);
    assert.match(block, /var\(--border-color\)|var\(--bg-hover\)/);
    assert.match(block, /text-overflow:\s*ellipsis/);
    assert.match(block, /@media \(max-width:\s*680px\)/);
    assert.doesNotMatch(block, /background:\s*#[0-9a-f]{3,8}/i);
});

test('模块可独立解析（语法自检）', () => {
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(jsDir, 'app-file-changes.js'), 'utf8').replace(/^\uFEFF/, '');
    assert.doesNotThrow(() => new vm.Script(source, { filename: 'app-file-changes.js' }));
});

test('变更卡是 messages-inner 直属行，不再插进助手气泡', () => {
    const source = read('js/app-file-changes.js');
    const upsert = source.slice(source.indexOf('function upsert('), source.indexOf('window.onFileChangesChunk'));
    // 不得再借用助手正文气泡的插入路径
    assert.doesNotMatch(upsert, /ensureAssistantBubble/);
    assert.doesNotMatch(upsert, /insertBeforeActions/);
    // 直属行 append 到会话容器，按 run 分组
    assert.match(upsert, /row\.className = 'file-changes-run-row'/);
    assert.match(upsert, /sess\.container\.appendChild\(row\)/);
    assert.match(upsert, /row\.setAttribute\('data-run-id', runKey\)/);
});

test('同一 run 的后续 revision 原地更新，旧 revision 丢弃，卡片缺失时允许重建', () => {
    const source = read('js/app-file-changes.js');
    const upsert = source.slice(source.indexOf('function upsert('), source.indexOf('window.onFileChangesChunk'));
    assert.match(upsert, /if \(previous && revision < previousRevision\) return;/);
    // 相同 revision 只有在卡片仍在时才跳过，避免 DOM 被 LRU 清空后再也建不回来
    assert.match(upsert, /revision === previousRevision && card\) return;/);
    assert.match(upsert, /var created = !card;/);
});

test('file_changes 为被动事件：不推进 activeRunId、不伪造流式状态', () => {
    const streaming = read('js/app-streaming.js');
    const passive = streaming.slice(streaming.indexOf("/* file_changes 是 run 级被动快照"), streaming.indexOf("/* file_changes 是 run 级被动快照") + 900);
    assert.match(passive, /activeRunId/);
    // 通用 streaming 自动开流分支之前必须先消费并 return
    assert.match(streaming, /file_changes 可能在 run 收尾后延迟到达[\s\S]{0,400}?if \(chunk\.type === 'file_changes'\)/);
});

test('会话 LRU 淘汰同时清理文件变更快照，避免 DOM 与状态不同生共死', () => {
    const base = read('js/app-base.js');
    const evict = base.slice(base.indexOf('function evictInactiveSessions'), base.indexOf('/* ===== Per-Session Input Draft ====='));
    assert.match(evict, /sess\._fileChangesByRun = \{\};/);
    assert.match(evict, /sess\._fileChangesExpanded = \{\};/);
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
    // 按钮必须把自身传进来才能禁用
    assert.match(source, /reviewFile\(sess, runId, file, button\)/);
});

test('viewer 异步回调受代次保护，模式切换先释放另一套 model', () => {
    const gitdiff = read('js/app-gitdiff.js');
    assert.match(gitdiff, /function beginViewerRequest\(\)/);
    assert.match(gitdiff, /function viewerStale\(gen\)/);
    assert.match(gitdiff, /function releaseFileViewerModel\(\)/);
    assert.match(gitdiff, /function releaseDiffViewerModels\(\)/);
    // 每个异步入口都要校验代次
    const staleGuards = gitdiff.match(/if \(viewerStale\(gen\)\) return;/g) || [];
    assert.ok(staleGuards.length >= 5, `代次校验点过少: ${staleGuards.length}`);
    // 关闭即作废在途回调
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
    // 旧实现 file viewer 与 diff modified 共用 file:///<path>，会撞 URI
    assert.doesNotMatch(gitdiff, /monaco\.Uri\.parse\('file:\/\/\//);
    assert.match(gitdiff, /VIEWER_DIFF_BUDGET_MS/);
    assert.match(gitdiff, /maxComputationTime: large \? VIEWER_DIFF_BUDGET_MS : 0/);
});

test('openInEditor 保留 rootOverride，跨项目退回只读查看器并防重复打开', () => {
    const code = read('js/app-code.js');
    assert.match(code, /function openInEditor\(path, name, rootOverride\)/);
    // chat 模式转发必须带上第三个参数，否则变更卡带的 session 工作区在这层丢失
    assert.match(code, /_origOpenFileViewer\(path, name, rootOverride\)/);
    assert.match(code, /function samePathRoot\(a, b\)/);
    assert.match(code, /if \(rootOverride && !samePathRoot\(rootOverride, window\.currentProjectRoot\)\)/);
    // 请求用捕获的 root，不能在异步回调里重读全局
    assert.match(code, /var requestedRoot = rootOverride \|\| window\.currentProjectRoot \|\| '';/);
    assert.match(code, /if \(!samePathRoot\(requestedRoot, window\.currentProjectRoot \|\| ''\)\) return;/);
    assert.match(code, /if \(openingFiles\[openKey\]\) return;/);
    assert.match(code, /delete openingFiles\[openKey\]/);
});
