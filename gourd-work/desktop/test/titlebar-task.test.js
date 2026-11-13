/* 标题栏任务名：不显示「新对话」占位文案
 *
 * 用户要求：主页面（顶部标题栏左端）不要出现「新对话」字样。
 * 缺陷机制：app-titlebar-task.js 原先对「有活动会话但侧栏尚未登记」的情况走
 * fallbackName() → GourdI18n.t('history.new_chat') = "新对话"。而点「新建任务」
 * 进欢迎页时 switchToWelcomeMode() 已经生成了新 SESSION_ID 并 setActiveSession()，
 * activeSessionId 非空、条目却还没登记（首条消息发送才经 ensureChatInHistory 登记），
 * 于是每次开新对话都会在标题栏亮出「新对话」。
 *
 * 现在的契约：未定名 = 整块隐藏，没有任何占位回落文案；拿到真实名字后才显示。
 * 这里用 vm 直接跑真实模块（无 DOM 依赖，只需两个 getElementById + 一个全局），
 * 避免"只在注释里写了不显示"式的假修复。 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'ui', 'js', 'app-titlebar-task.js'),
    'utf8'
);

/* 覆盖视图桩：模块只读 classList.contains('active'/'memory-overlay') */
function makeViewEl(classes) {
    const set = new Set(classes || []);
    return { classList: { contains: (c) => set.has(c) } };
}

function render(state) {
    const chip = { hidden: true };
    const label = { textContent: '' };
    const viewEls = {};
    const views = state.views || {};
    for (const vid of Object.keys(views)) viewEls[vid] = makeViewEl(views[vid]);
    const sandbox = {
        document: {
            getElementById: id => (id === 'titlebarTask' ? chip
                : id === 'titlebarTaskLabel' ? label
                : (viewEls[id] || null)),
            addEventListener: () => {},
        },
        // 模块读 window.chatHistory，但 activeSessionId 是裸全局——两种形态都必须给，
        // 否则 harness 只会走到「查无条目」分支，测不出真实回归。
        window: { chatHistory: state.chatHistory || [] },
        activeSessionId: state.activeSessionId,
        GourdI18n: { t: k => (k === 'history.new_chat' ? '新对话' : k) },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return { hidden: chip.hidden, text: label.textContent };
}

test('新会话尚未定名 → 整块隐藏，不回落到「新对话」', () => {
    assert.deepStrictEqual(
        render({ activeSessionId: 'work-abc123', chatHistory: [] }),
        { hidden: true, text: '' }
    );
});

test('无活动会话（欢迎页/覆盖视图）→ 隐藏', () => {
    assert.deepStrictEqual(
        render({ activeSessionId: null, chatHistory: [] }),
        { hidden: true, text: '' }
    );
});

test('已定名会话 → 原样显示真实任务名', () => {
    assert.deepStrictEqual(
        render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '修复上下文丢失' }],
        }),
        { hidden: false, text: '修复上下文丢失' }
    );
});

test('label 为空串同样视为未定名 → 隐藏（不得显示空标题）', () => {
    assert.deepStrictEqual(
        render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '' }],
        }),
        { hidden: true, text: '' }
    );
});

test('绝不用 sessionId 兜底：内部键不得出现在标题栏', () => {
    const r = render({ activeSessionId: 'work-mtsg8z30', chatHistory: [] });
    assert.strictEqual(r.hidden, true);
    assert.ok(!String(r.text).includes('work-'), 'internal session id leaked: ' + r.text);
});

/* 用户 2026-11-12 报障：切到侧栏上方菜单（使用统计等）后，头部仍挂着上一个
 * 任务名。根因：六个覆盖视图只隐藏 #chatView、不清 activeSessionId，而标题栏
 * 只认 activeSessionId。契约：覆盖视图 .active 期间整块隐藏；关闭后恢复真名。 */
test('覆盖视图开启（使用统计等）→ 隐藏，不残留上一个任务名', () => {
    assert.deepStrictEqual(
        render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '你排查下记忆的实现' }],
            views: { usageView: ['usage-view', 'active'] },
        }),
        { hidden: true, text: '' }
    );
});

test('覆盖视图关闭（class 摘除）→ 恢复真实任务名', () => {
    assert.deepStrictEqual(
        render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '你排查下记忆的实现' }],
            views: { usageView: ['usage-view'] },
        }),
        { hidden: false, text: '你排查下记忆的实现' }
    );
});

test('六个覆盖视图 id 全部识别（漏一个即重现残留标头）', () => {
    for (const vid of ['skillsView', 'automationView', 'channelView',
        'usageView', 'modelSettingsView', 'memoryView']) {
        const r = render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '任务名' }],
            views: { [vid]: ['active'] },
        });
        assert.deepStrictEqual(r, { hidden: true, text: '' }, vid + ' 开启时必须隐藏标题');
    }
});

test('记忆专注模式弹层（.memory-overlay）不隐藏标题：底层会话仍在使用', () => {
    assert.deepStrictEqual(
        render({
            activeSessionId: 'work-abc123',
            chatHistory: [{ sessionId: 'work-abc123', label: '任务名' }],
            views: { memoryView: ['memory-view', 'memory-overlay', 'active'] },
        }),
        { hidden: false, text: '任务名' }
    );
});

test('覆盖视图判定必须读六个视图节点的 class，且由 class 观察器驱动重绘', () => {
    assert.match(SRC, /OVERLAY_VIEW_IDS/, '必须有覆盖视图 id 清单');
    for (const vid of ['skillsView', 'automationView', 'channelView',
        'usageView', 'modelSettingsView', 'memoryView']) {
        assert.ok(SRC.includes("'" + vid + "'"), '清单必须含 ' + vid);
    }
    assert.match(SRC, /MutationObserver/, 'openX/closeX 不派发事件，必须观察 class 变化收口');
    assert.match(SRC, /attributeFilter:\s*\['class'\]/, '只观察 class，避免无关属性空转');
});

test('可执行代码中不存在任何产生「新对话」的路径（注释除外）', () => {
    const code = SRC
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/新对话/.test(code), 'literal wording still reachable in code');
    assert.ok(!/history\.new_chat/.test(code), 'i18n key still referenced in code');
});
