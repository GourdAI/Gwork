const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticJs = path.resolve(__dirname, '../../main/resources/static/js');
const {
    resolveToolPresentation,
    resolveActionStartCardState,
    ordinaryToolNameCleanupAttributes
} = require(path.join(staticJs, 'app-tool-presentation.js'));
const translate = (key) => ({ 'chat.tool_read': '读取' }[key] || key);

test('主会话 read 保留裸工具语义与本地化展示', () => {
    const model = resolveToolPresentation('read', 'read', { translate });
    assert.equal(model.bareToolName, 'read');
    assert.equal(model.displayName, '读取');
    assert.equal(model.icon, '📖');
    assert.equal(model.nested, false);
});

test('nested explore/read 隐藏 agent 前缀但保留可解析来源', () => {
    const model = resolveToolPresentation('read', 'explore/read', {
        nested: true,
        agentName: 'explore',
        translate
    });
    assert.equal(model.bareToolName, 'read');
    assert.equal(model.displayName, '读取');
    assert.equal(model.source, 'explore');
    assert.equal(model.agentName, 'explore');
    assert.equal(model.nested, true);
});

test('主会话带来源标题维持既有前缀展示兼容', () => {
    const model = resolveToolPresentation('read', 'explore/read', { translate });
    assert.equal(model.displayName, 'explore/读取');
    assert.equal(model.bareToolName, 'read');
});

test('旧输入仅 toolName 带来源前缀时仍保留来源展示契约', () => {
    const topLevel = resolveToolPresentation('explore/read', null, { translate });
    assert.equal(topLevel.bareToolName, 'read');
    assert.equal(topLevel.source, 'explore');
    assert.equal(topLevel.agentName, 'explore');
    assert.equal(topLevel.displayName, 'explore/读取');

    const nested = resolveToolPresentation('explore/read', null, { nested: true, translate });
    assert.equal(nested.bareToolName, 'read');
    assert.equal(nested.source, 'explore');
    assert.equal(nested.displayName, '读取');
});

test('approved action_start 纯决策按 actionId 选择复用配对方式', () => {
    assert.deepEqual(resolveActionStartCardState(true, 'action-1'), {
        reuseApprovedCard: true,
        registerByActionId: true,
        usePendingPairing: false
    });
    assert.deepEqual(resolveActionStartCardState(true, null), {
        reuseApprovedCard: true,
        registerByActionId: false,
        usePendingPairing: true
    });
    assert.equal(resolveActionStartCardState(false, 'action-1').reuseApprovedCard, false);
});

test('普通工具标题接管时声明清理全部 HITL 重译属性', () => {
    assert.deepEqual(ordinaryToolNameCleanupAttributes(), [
        'data-i18n-hitl',
        'data-i18n-hitl-tool'
    ]);
});
test('未知工具与空 title 稳定回退', () => {
    const unknown = resolveToolPresentation('custom_tool', '', { translate });
    assert.equal(unknown.bareToolName, 'custom_tool');
    assert.equal(unknown.displayName, 'custom_tool');
    assert.equal(unknown.icon, '🔧');
    assert.equal(unknown.source, '');

    const empty = resolveToolPresentation('', '', { translate });
    assert.equal(empty.bareToolName, 'tool');
    assert.equal(empty.displayName, 'tool');
});

test('语言切换契约持久化 nested 标记并由公共模型重建标题', () => {
    const source = fs.readFileSync(path.join(staticJs, 'app-message.js'), 'utf8').replace(/^\uFEFF/, '');
    assert.match(source, /data-i18n-tool-nested/);
    assert.match(source, /nested: el\.getAttribute\('data-i18n-tool-nested'\) === '1'/);
    assert.match(source, /resolveToolPresentation\([\s\S]*?presentation\.displayName/);
});

test('HITL 复用调用契约消费批准卡、登记 actionId 并清除旧重译属性', () => {
    const source = fs.readFileSync(path.join(staticJs, 'app-message.js'), 'utf8').replace(/^\uFEFF/, '');
    assert.match(source, /resolveActionStartCardState\(!!sess\.approvedToolCard, actionId\)/);
    assert.match(source, /var approvedCard = sess\.approvedToolCard;\s*sess\.approvedToolCard = null;/);
    assert.match(source, /sess\.toolCardsById\[actionId\] = approvedCard/);
    assert.match(source, /ordinaryToolNameCleanupAttributes\(\)\.forEach/);
    assert.match(source, /data-i18n-hitl-tool', toolName \|\| 'unknown'/);
});
test('公共模块先于 app-message 加载且所有 action_end 路径复用公共更新', () => {
    const bootstrap = fs.readFileSync(path.join(staticJs, 'app-bootstrap.js'), 'utf8');
    const message = fs.readFileSync(path.join(staticJs, 'app-message.js'), 'utf8');
    assert.ok(bootstrap.indexOf("'/js/app-tool-presentation.js'") < bootstrap.indexOf("'/js/app-message.js'"));
    assert.equal((message.match(/function formatArgValue\(/g) || []).length, 1);
    assert.ok((message.match(/updateToolCardContent\(/g) || []).length >= 5);
    assert.match(message, /fillToolBody\(sess, bodyEl, bareToolName/);
});
