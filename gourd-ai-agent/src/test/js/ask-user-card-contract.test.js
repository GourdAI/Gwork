/**
 * 契约测试：Agent 结构化问答卡（ask_user）。
 *
 * 覆盖：
 * - app-streaming.js：PHASE_QUESTION 常量与相位推断；showPhaseIndicator 短路（卡片自带交互，
 *   不叠底部指示器）；onWebChunk 的 question/question_answered 分支；
 *   sendMessage 顶部「问答挂起 → 输入框文本记为当前题自定义答案」路由（位于 streaming 分支之前）
 * - app-message.js：appendQuestionCard / handleQuestionResponse / handleQuestionAnsweredFrame /
 *   syncQuestionCard / getPendingQuestionState / applyQuestionCustomAnswerByText 存在；
 *   提交字段名 questionAnswer / answers / index / text / skipped / custom 冻结
 * - app-base.js：setActiveSession / deactivateSession 挂 syncQuestionCard（切会话重建/隐藏）
 * - chat.html：#questionCardHost 宿主容器在 .input-wrap 内、输入框上方
 * - app.css：.question-card 系列类与暗色兼容变量
 * - 12 个语言包均提供 9 个 chat.question_* 键（JSON 合法、行尾无裸 LF）
 * - 行为：状态机（选/跳/推进/自定义/提交 payload 组装）在沙箱中提取真实源码执行
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const streaming = readStatic('js', 'app-streaming.js');
const message = readStatic('js', 'app-message.js');
const base = readStatic('js', 'app-base.js');
const chatHtml = readStatic('chat.html');
const appCss = readStatic('css', 'app.css');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const QUESTION_KEYS = ['question_waiting', 'question_other', 'question_skip', 'question_submit',
    'question_recommended', 'question_answered', 'question_skipped', 'question_close',
    'question_attachment_wait'];

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/* 提取 app-message.js 内状态机区块（纯函数）并在沙箱执行，供行为断言 */
const smBlock = sliceBetween(message, '/* ---- 问答卡状态机', '/* ---- 问答卡 DOM 渲染');
const sm = new Function(smBlock + '\nreturn {' +
    'normalizeQuestionArgs: normalizeQuestionArgs, ' +
    'createQuestionCardState: createQuestionCardState, ' +
    'questionAnswerFor: questionAnswerFor, ' +
    'questionOptionSelected: questionOptionSelected, ' +
    'questionIsAllAnswered: questionIsAllAnswered, ' +
    'advanceQuestionCursor: advanceQuestionCursor, ' +
    'applyQuestionOptionAnswer: applyQuestionOptionAnswer, ' +
    'applyQuestionCustomAnswer: applyQuestionCustomAnswer, ' +
    'skipQuestionAnswer: skipQuestionAnswer, ' +
    'fillUnansweredAsSkipped: fillUnansweredAsSkipped, ' +
    'buildQuestionAnswersPayload: buildQuestionAnswersPayload' +
    '};')();

test('app-streaming.js：PHASE_QUESTION 常量、相位推断与指示器短路', () => {
    assert.match(streaming, /var PHASE_QUESTION = 'question';/);
    const infer = sliceBetween(streaming, 'function inferPhaseFromType', '/* 静默到期时按相位决定');
    assert.match(infer, /case 'question': return PHASE_QUESTION;/);
    const indicator = sliceBetween(streaming, 'function showPhaseIndicator', '/* ===== WebChunk Handling');
    assert.match(indicator, /phase === PHASE_QUESTION/);
});

test('app-streaming.js：onWebChunk 含 question / question_answered 分支', () => {
    const chunkFn = sliceBetween(streaming, 'function onWebChunk', 'function finishStream');
    assert.match(chunkFn, /case 'question': finishThinkingBlock\(sess\); finishAgentThinkingBlock\(sess\); finishPendingTool\(sess\); clearRetryChunk\(sess\); appendQuestionCard\(sess, chunk\); break;/);
    assert.match(chunkFn, /case 'question_answered': handleQuestionAnsweredFrame\(sess, chunk\); break;/);
});

test('app-streaming.js：sendMessage 顶部问答挂起路由位于 streaming 分支之前，且附件不被吞', () => {
    const send = sliceBetween(streaming, 'function sendMessage', 'function sendWithFormData');
    assert.match(send, /getPendingQuestionState\(sessionMap\[activeSessionId\]\)/);
    assert.match(send, /applyQuestionCustomAnswerByText\(sessionMap\[activeSessionId\], text\)/);
    const routeIdx = send.indexOf('getPendingQuestionState');
    const blockedIdx = send.indexOf('var isBlocked');
    assert.ok(routeIdx >= 0 && blockedIdx > routeIdx, '问答路由必须拦截在 streaming/steer/queue 分支之前');

    /* 答案协议只有 text 字段，附件无处安放：问答挂起期带附件必须提示并保留（禁止静默吞掉），
       且该检查须早于把文本记为答案的分支，否则附件会随 clearInput 一起被清掉。 */
    const route = send.slice(routeIdx, blockedIdx);
    assert.match(route, /pendingFiles\.length > 0/, '问答挂起期必须检查附件');
    assert.match(route, /chat\.question_attachment_wait/, '带附件时必须给出明确提示文案');
    const filesIdx = route.indexOf('pendingFiles.length > 0');
    const applyIdx = route.indexOf('applyQuestionCustomAnswerByText');
    assert.ok(filesIdx >= 0 && applyIdx > filesIdx, '附件检查必须早于文本记为答案的分支');
});

test('app-message.js：问答卡函数齐全且提交契约冻结（questionAnswer/answers/index/text/skipped/custom）', () => {
    assert.match(message, /function appendQuestionCard\(sess, chunk\)/);
    assert.match(message, /function handleQuestionResponse\(sess, state\)/);
    assert.match(message, /function handleQuestionAnsweredFrame\(sess\)/);
    assert.match(message, /function syncQuestionCard\(opts\)/);
    assert.match(message, /function getPendingQuestionState\(sess\)/);
    assert.match(message, /function applyQuestionCustomAnswerByText\(sess, text\)/);

    const submit = sliceBetween(message, 'function handleQuestionResponse', 'function applyQuestionCustomAnswerByText');
    assert.match(submit, /formData\.append\('questionAnswer', JSON\.stringify\(buildQuestionAnswersPayload\(state\)\)\);/);
    assert.match(submit, /formData\.append\('sessionId', sess\.sessionId\);/);
    assert.match(submit, /'X-Session-Cwd'/);
    assert.match(submit, /resetStreamState\(sess\);/);
    assert.match(submit, /setBtnStopMode\(\);/);
    assert.match(submit, /showThinking\(sess\);/);
    assert.match(submit, /if \(onFinishStream\) onFinishStream\(sess\);/);
    const resetIdx = submit.indexOf('resetStreamState(sess)');
    const streamIdx = submit.indexOf('sess.isStreaming = true');
    assert.ok(resetIdx >= 0 && streamIdx > resetIdx, '提交必须先重置再进入流式态（镜像 handleHitlResponse）');

    const payload = sliceBetween(message, 'function buildQuestionAnswersPayload', '/* ---- 问答卡 DOM 渲染');
    assert.match(payload, /index: i,/);
    assert.match(payload, /text:/);
    assert.match(payload, /skipped: !!a\.skipped,/);
    assert.match(payload, /custom: !!a\.custom/);
    assert.match(payload, /return \{ answers: out \};/);
});

test('app-message.js：X 跳过剩余直接提交；answered 帧清状态并隐藏；语言切换重建卡片', () => {
    const events = sliceBetween(message, 'function bindQuestionCardEvents', 'function activeQuestionCardState');
    assert.match(events, /fillUnansweredAsSkipped\(st\)/);
    assert.match(events, /handleQuestionResponse\(sessionMap\[activeSessionId\], st\)/);

    const answered = sliceBetween(message, 'function handleQuestionAnsweredFrame', '/* 按当前活动会话的问答状态同步卡片');
    assert.match(answered, /sess\._questionState = null;/);
    assert.match(answered, /syncQuestionCard\(\)/);

    const reloc = sliceBetween(message, 'function relocalizeDynamicLabels', "document.addEventListener('i18n:localeChanged'");
    assert.match(reloc, /syncQuestionCard\(\)/);
});

test('app-base.js：setActiveSession / deactivateSession 挂问答卡会话切换同步', () => {
    const setActive = sliceBetween(base, 'function setActiveSession(sessionId)', 'function deactivateSession()');
    assert.match(setActive, /syncQuestionCard/);
    const deactivate = sliceBetween(base, 'function deactivateSession()', '/* ===== Helpers ===== */');
    assert.match(deactivate, /syncQuestionCard/);
});

test('chat.html：#questionCardHost 宿主位于 .input-wrap 内、输入框上方', () => {
    const wrapIdx = chatHtml.indexOf('class="input-wrap"');
    const hostIdx = chatHtml.indexOf('id="questionCardHost"');
    const boxIdx = chatHtml.indexOf('id="chatDropZone"');
    assert.ok(wrapIdx >= 0 && hostIdx > wrapIdx && boxIdx > hostIdx, '宿主必须在 .input-wrap 内且位于输入框之前');
    assert.match(chatHtml, /class="question-card-host"/);
});

test('app.css：.question-card 系列类与暗色兼容变量', () => {
    assert.match(appCss, /\.question-card-host \{/);
    assert.match(appCss, /\.question-card \{/);
    assert.match(appCss, /\.question-card-option\b/);
    assert.match(appCss, /\.question-card-submit\b/);
    assert.match(appCss, /\.question-card-other-input\b/);
    assert.match(appCss, /\.question-card-nav-count\b/);
    const card = sliceBetween(appCss, '.question-card {', '.question-card-header');
    assert.match(card, /var\(--bg-input-box\)/);
    assert.match(card, /var\(--border-color\)/);
});

test('12 个语言包均提供 9 个 chat.question_* 键（JSON 合法、行尾无裸 LF）', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        for (const key of QUESTION_KEYS) {
            assert.equal(typeof json.chat[key], 'string', `${lang} 缺少 chat.${key}`);
            assert.ok(json.chat[key].trim().length > 0, `${lang} 的 chat.${key} 为空`);
        }
        const latin = fs.readFileSync(path.join(staticRoot, 'locales', `${lang}.json`), 'latin1');
        const loneLf = latin.split('\n').filter((line, i, arr) => i < arr.length - 1 && !line.endsWith('\r')).length;
        assert.equal(loneLf, 0, `${lang}.json 存在裸 LF 行，行尾被破坏`);
    }
});

test('行为：状态机区块为纯函数（不引用 DOM/全局）', () => {
    assert.doesNotMatch(smBlock, /document\.|window\.|\$\(/);
});

test('行为：选项/自定义/跳过推进状态机（选自动推进、跳过已有答案仅推进）', () => {
    const state = sm.createQuestionCardState('a1', sm.normalizeQuestionArgs({
        questions: [
            { header: 'Q1', options: [{ label: 'A' }, { label: 'B', recommended: true }] },
            { header: 'Q2' },
            { header: 'Q3', options: [{ label: 'C' }] }
        ]
    }));
    assert.equal(state.questions.length, 3);
    assert.equal(state.questions[0].options[1].recommended, true);
    assert.equal(sm.questionIsAllAnswered(state), false);

    // 1. 点选项：记录 + 自动推进
    sm.applyQuestionOptionAnswer(state, state.current, 'B');
    assert.deepEqual(state.answers[0], { index: 0, text: 'B', skipped: false, custom: false });
    assert.equal(sm.questionOptionSelected(state, 0, 'B'), true);
    assert.equal(sm.questionOptionSelected(state, 0, 'A'), false);
    assert.equal(state.current, 1);

    // 2. 跳过：记录 skipped + 推进
    sm.skipQuestionAnswer(state);
    assert.deepEqual(state.answers[1], { index: 1, text: '', skipped: true, custom: false });
    assert.equal(state.current, 2);

    // 3. 跳过已有答案的题：仅推进，不覆盖
    state.current = 0;
    sm.skipQuestionAnswer(state);
    assert.equal(state.answers[0].text, 'B', '跳过已有答案的题不得覆盖既有答案');
    assert.equal(state.answers[0].skipped, false);
    assert.equal(state.current, 1);

    // 4. 自定义答案（其他补充）
    state.current = 2;
    sm.applyQuestionCustomAnswer(state, state.current, '自定义文本');
    assert.deepEqual(state.answers[2], { index: 2, text: '自定义文本', skipped: false, custom: true });
    assert.equal(state.current, 2, '最后一题答完停留在本题');
    assert.equal(sm.questionIsAllAnswered(state), true);
});

test('行为：提交 payload 组装（X 跳过剩余 + 字段名冻结）', () => {
    const state = sm.createQuestionCardState('a2', sm.normalizeQuestionArgs({
        questions: [
            { header: 'Q1', options: [{ label: 'A' }] },
            { header: 'Q2' },
            { header: 'Q3' }
        ]
    }));
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    sm.applyQuestionCustomAnswer(state, 1, 'free text');
    sm.fillUnansweredAsSkipped(state);
    const payload = sm.buildQuestionAnswersPayload(state);
    assert.deepEqual(payload, {
        answers: [
            { index: 0, text: 'A', skipped: false, custom: false },
            { index: 1, text: 'free text', skipped: false, custom: true },
            { index: 2, text: '', skipped: true, custom: false }
        ]
    });
    for (const a of payload.answers) {
        assert.deepEqual(Object.keys(a).sort(), ['custom', 'index', 'skipped', 'text']);
    }
    assert.deepEqual(sm.normalizeQuestionArgs({ questions: [{ header: 'H', detail: 'D' }] }),
        [{ header: 'H', detail: 'D', options: [] }]);
});
