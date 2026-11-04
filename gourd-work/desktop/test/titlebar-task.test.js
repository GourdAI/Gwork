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

function render(state) {
    const chip = { hidden: true };
    const label = { textContent: '' };
    const sandbox = {
        document: {
            getElementById: id => (id === 'titlebarTask' ? chip
                : id === 'titlebarTaskLabel' ? label : null),
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

test('可执行代码中不存在任何产生「新对话」的路径（注释除外）', () => {
    const code = SRC
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/新对话/.test(code), 'literal wording still reachable in code');
    assert.ok(!/history\.new_chat/.test(code), 'i18n key still referenced in code');
});
