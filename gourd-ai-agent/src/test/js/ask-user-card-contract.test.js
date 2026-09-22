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
 * - 选项行无末尾小箭头；入场动画仅首次渲染（勾选/翻页整卡不再闪一下）
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
const ui = readStatic('js', 'app-ui.js');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const QUESTION_KEYS = ['question_waiting', 'question_other', 'question_other_placeholder', 'question_skip',
    'question_next', 'question_submit', 'question_recommended', 'question_answered', 'question_skipped',
    'question_close', 'question_attachment_wait', 'question_supplement', 'question_supplement_placeholder'];

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
    'questionOthersAllAnswered: questionOthersAllAnswered, ' +
    'questionHasPendingInput: questionHasPendingInput, ' +
    'questionSubmitMode: questionSubmitMode, ' +
    'advanceQuestionCursor: advanceQuestionCursor, ' +
    'nextUnansweredQuestionIndex: nextUnansweredQuestionIndex, ' +
    'applyQuestionOptionAnswer: applyQuestionOptionAnswer, ' +
    'applyQuestionCustomAnswer: applyQuestionCustomAnswer, ' +
    'applyQuestionSupplement: applyQuestionSupplement, ' +
    'composeQuestionAnswerText: composeQuestionAnswerText, ' +
    'skippedAnswer: skippedAnswer, ' +
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
    assert.match(message, /function handleQuestionAnsweredFrame\(sess, chunk\)/);
    assert.match(message, /function syncQuestionCard\(opts\)/);
    assert.match(message, /function getPendingQuestionState\(sess\)/);
    assert.match(message, /function applyQuestionCustomAnswerByText\(sess, text\)/);

    const submit = sliceBetween(message, 'function handleQuestionResponse', 'function applyQuestionCustomAnswerByText');
    // 提交已统一走 postChatInput（公共入口负责 sessionId / model / X-Session-Cwd），
    // 这里只冻结【数据契约】：字段名与取值方式不变；不再锁定「怎么发」这一实现细节
    // （fields 已提为局部变量，以便按存在性追加 actionId，见 pending-task-identity-contract.test.js）。
    assert.match(submit, /postChatInput\(sess, fields, null, \{/);
    assert.match(submit, /questionAnswer: JSON\.stringify\(buildQuestionAnswersPayload\(state\)\)/);
    // 续轮路径绝不能带 input 键：后端靠它的存在性区分新一轮与续轮
    assert.ok(!/input\s*:/.test(submit), '问答卡提交不得携带 input 键');
    assert.match(submit, /resetStreamState\(sess\);/);
    assert.match(submit, /setBtnStopMode\(\);/);
    assert.match(submit, /showThinking\(sess\);/);
    assert.match(submit, /if \(onFinishStream\) onFinishStream\(sess\);/);
    const resetIdx = submit.indexOf('resetStreamState(sess)');
    const streamIdx = submit.indexOf('sess.isStreaming = true');
    assert.ok(resetIdx >= 0 && streamIdx > resetIdx, '提交必须先重置再进入流式态（镜像 handleHitlResponse）');

    // sessionId 与工作空间根的保障下沉到公共入口，在那里断言
    const post = sliceBetween(streaming, 'function postChatInput', 'function sendWithFormDataGrouped');
    assert.match(post, /formData\.append\('sessionId', sess\.sessionId\);/);
    assert.match(post, /'X-Session-Cwd'/);

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

test('app-message.js：选项行不再渲染末尾小箭头（“选完最后一个就发送”的误导已移除）', () => {
    assert.doesNotMatch(message, /question-card-opt-arrow/);
    assert.doesNotMatch(message, /QUESTION_CARD_SVG_ARROW/);
    assert.doesNotMatch(appCss, /question-card-opt-arrow/);
});

test('app-message.js / app.css：入场动画仅首次渲染播放（勾选/翻页整卡不再闪一下）', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /var entering = state\._entered \? '' : ' question-card-enter';/);
    assert.match(render, /state\._entered = true;/);
    assert.ok(render.includes("(submitted ? ' submitted' : '') + entering"), '重建时必须按首次渲染状态拼接进入类');
    // 基类规则不得再挂动画；动画只允许挂在首次渲染标记类上
    assert.doesNotMatch(appCss, /\.question-card \{[^}]*animation:/);
    assert.match(appCss, /\.question-card\.question-card-enter \{ animation: msg-in 0\.25s ease-out; \}/);
});

test('12 个语言包均提供 13 个 chat.question_* 键与问答挂起 placeholder 键（JSON 合法、行尾无裸 LF）', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        for (const key of QUESTION_KEYS) {
            assert.equal(typeof json.chat[key], 'string', `${lang} 缺少 chat.${key}`);
            assert.ok(json.chat[key].trim().length > 0, `${lang} 的 chat.${key} 为空`);
        }
        assert.equal(typeof json.app.placeholder_chat_question, 'string', `${lang} 缺少 app.placeholder_chat_question`);
        assert.ok(json.app.placeholder_chat_question.trim().length > 0, `${lang} 的 app.placeholder_chat_question 为空`);
        const latin = fs.readFileSync(path.join(staticRoot, 'locales', `${lang}.json`), 'latin1');
        const loneLf = latin.split('\n').filter((line, i, arr) => i < arr.length - 1 && !line.endsWith('\r')).length;
        assert.equal(loneLf, 0, `${lang}.json 存在裸 LF 行，行尾被破坏`);
    }
});

test('app-message.js / app-base.js：问答挂起期主输入框 placeholder 联动（question > running > idle）', () => {
    /* syncQuestionCard 是挂起标志的唯一漏斗：所有问答状态变更（帧到达/交互/提交/切会话）
       都汇入此处，标志变更时触发 app-base.js 的 applyChatPlaceholder 重算。 */
    const sync = sliceBetween(message, 'function syncQuestionCard', '/* 渲染卡片到宿主');
    assert.match(sync, /getPendingQuestionState\(sess\)/, '挂起判定必须复用 getPendingQuestionState 口径');
    assert.match(sync, /window\._questionPendingHint = pendingHint;/);
    assert.match(sync, /applyChatPlaceholder\(\)/, '标志变更必须触发 placeholder 重算');

    const apply = sliceBetween(base, 'function applyChatPlaceholder', 'function autoResize');
    assert.match(apply, /_questionPendingHint/);
    assert.match(apply, /'app\.placeholder_chat_question'/);
    const qIdx = apply.indexOf('_questionPendingHint');
    const rIdx = apply.indexOf('_runHintVisible');
    assert.ok(qIdx >= 0 && rIdx > qIdx, '问答挂起提示必须优先于运行态提示判断');

    const decl = sliceBetween(base, 'window._runHintVisible = false;', 'function setRunHintVisible');
    assert.match(decl, /window\._questionPendingHint = false;/, '挂起标志声明须与运行态标志并列，默认关闭');
});

test('app-message.js：卡片内「自己输入」编辑态 placeholder 用专用键，静态入口行文案用 question_other', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /GourdI18n\.t\('chat\.question_other_placeholder'\)/, '编辑态输入框必须用 question_other_placeholder');
    const otherKeyUses = render.match(/GourdI18n\.t\('chat\.question_other'\)/g) || [];
    assert.equal(otherKeyUses.length, 1, 'question_other 仅用于静态入口行文案，不得再用作输入框 placeholder');
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
    assert.equal(state.answers[0].text, 'B');
    assert.equal(state.answers[0].selectedLabel, 'B', '选项标签必须单独留档，供高亮与补充共存判定');
    assert.equal(state.answers[0].custom, false);
    assert.equal(state.answers[0].skipped, false);
    assert.equal(sm.questionOptionSelected(state, 0, 'B'), true);
    assert.equal(sm.questionOptionSelected(state, 0, 'A'), false);
    assert.equal(state.current, 1);

    // 2. 跳过：记录 skipped + 推进
    sm.skipQuestionAnswer(state);
    assert.deepEqual(state.answers[1], sm.skippedAnswer(1));
    assert.equal(state.answers[1].skipped, true);
    assert.equal(state.current, 2);

    // 3. 跳过已有答案的题：仅推进，不覆盖
    state.current = 0;
    sm.skipQuestionAnswer(state);
    assert.equal(state.answers[0].text, 'B', '跳过已有答案的题不得覆盖既有答案');
    assert.equal(state.answers[0].skipped, false);
    assert.equal(state.current, 1);

    // 4. 自定义答案（本题无任何选项）
    state.current = 2;
    sm.applyQuestionCustomAnswer(state, state.current, '自定义文本');
    assert.equal(state.answers[2].text, '自定义文本');
    assert.equal(state.answers[2].custom, true, '未点选项的纯手写仍须标记 custom');
    assert.equal(state.current, 2, '最后一题答完停留在本题');
    assert.equal(sm.questionIsAllAnswered(state), true);
});

/* 核心回归：用户选完选项后再补一句，选项不得被静默顶掉（原实现用整条覆盖 answers[index]，
   导致 custom=true + text=补充，模型只看到补充、完全不知道用户选过什么）。 */
test('行为：已选选项后补充 → 选项与补充共存，custom 保持 false', () => {
    const state = sm.createQuestionCardState('s1', sm.normalizeQuestionArgs({
        questions: [{ header: '部署到哪个环境？', options: [{ label: 'staging' }, { label: 'prod' }] }]
    }));

    sm.applyQuestionOptionAnswer(state, 0, 'staging');
    sm.applyQuestionCustomAnswer(state, 0, '但先别动数据库');

    const a = state.answers[0];
    assert.equal(a.custom, false, '已点选项时补充不得把答案变成「自定义回答」');
    assert.equal(a.selectedLabel, 'staging', '选项必须原样保留');
    assert.equal(a.supplement, '但先别动数据库');
    assert.equal(a.text, 'staging（补充：但先别动数据库）');
    assert.equal(sm.questionOptionSelected(state, 0, 'staging'), true,
        'text 已拼入补充，选项高亮不得因此丢失');

    // 出站仍是四键，后端协议零改动
    assert.deepEqual(sm.buildQuestionAnswersPayload(state), {
        answers: [{ index: 0, text: 'staging（补充：但先别动数据库）', skipped: false, custom: false }]
    });
    assert.deepEqual(Object.keys(sm.buildQuestionAnswersPayload(state).answers[0]).sort(),
        ['custom', 'index', 'skipped', 'text'], 'payload 不得泄漏 selectedLabel/supplement 等本地语义位');
});

test('行为：补充可反复修改且不推进光标；清空补充回到「只选选项」', () => {
    const state = sm.createQuestionCardState('s2', sm.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }, { header: 'Q2' }]
    }));
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    assert.equal(state.current, 1);

    state.current = 0;
    sm.applyQuestionSupplement(state, 0, '第一版');
    assert.equal(state.current, 0, '补充是对当前题的注解，不是「答完了」，不得推进光标');

    sm.applyQuestionSupplement(state, 0, '改过一版');
    assert.equal(state.answers[0].supplement, '改过一版', '补充必须被替换而非无限累加');
    assert.equal(state.answers[0].text, 'A（补充：改过一版）');

    sm.applyQuestionSupplement(state, 0, '');
    assert.equal(state.answers[0].supplement, '');
    assert.equal(state.answers[0].text, 'A', '清空补充后回到纯选项文本');
    assert.equal(state.answers[0].custom, false);
});

test('行为：未选选项时清空补充 = 撤回本题作答（允许反悔）', () => {
    const state = sm.createQuestionCardState('s3', sm.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }, { header: 'Q2' }]
    }));
    sm.applyQuestionCustomAnswer(state, 0, '先随便写点');
    assert.equal(state.answers[0].custom, true);

    sm.applyQuestionSupplement(state, 0, '');
    assert.equal(state.answers[0], undefined, '既无选项也无补充时必须回到未作答态');
    assert.equal(sm.questionIsAllAnswered(state), false);
});

test('行为：改选另一个选项时已写的补充不被顶掉', () => {
    const state = sm.createQuestionCardState('s4', sm.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }, { label: 'B' }] }]
    }));
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    sm.applyQuestionSupplement(state, 0, '注意兼容旧版');
    sm.applyQuestionOptionAnswer(state, 0, 'B');
    assert.equal(state.answers[0].selectedLabel, 'B');
    assert.equal(state.answers[0].supplement, '注意兼容旧版', '用户先补一句再换选项，补充不该丢');
    assert.equal(state.answers[0].text, 'B（补充：注意兼容旧版）');
    assert.equal(sm.questionOptionSelected(state, 0, 'A'), false);
});

test('行为：composeQuestionAnswerText 四种组合形态（空值不产生空括号）', () => {
    assert.equal(sm.composeQuestionAnswerText('A', 'note'), 'A（补充：note）');
    assert.equal(sm.composeQuestionAnswerText('A', ''), 'A');
    assert.equal(sm.composeQuestionAnswerText('A', null), 'A');
    assert.equal(sm.composeQuestionAnswerText('', 'note'), 'note');
    assert.equal(sm.composeQuestionAnswerText(null, 'note'), 'note');
    assert.equal(sm.composeQuestionAnswerText('', ''), '');
    assert.equal(sm.composeQuestionAnswerText('  A  ', '  note  '), 'A（补充：note）', '两端空白必须归一');
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
/* ===== 提交收割：用户打了字但没按 Enter，点卡片「发送」时一个字都不能丢 =====
   这是本次修复的核心症状：选完选项后在底部输入框补一句，再点卡片上的「发送」，
   旧实现不经 sendMessage，那段文字既不入 answers 也不清空，模型完全收不到。 */

function loadHarvest(boxText) {
    const harvestSrc = sliceBetween(message, 'function harvestQuestionInputOnSubmit', '/* ===== Rewind Handling');
    const calls = { cleared: 0 };
    const api = new Function('activeSessionId', 'getInputText', 'clearInput',
        smBlock + '\n' + harvestSrc + '\nreturn {'
        + 'harvestQuestionInputOnSubmit: harvestQuestionInputOnSubmit, '
        + 'createQuestionCardState: createQuestionCardState, '
        + 'normalizeQuestionArgs: normalizeQuestionArgs, '
        + 'applyQuestionOptionAnswer: applyQuestionOptionAnswer, '
        + 'applyQuestionCustomAnswer: applyQuestionCustomAnswer, '
        + 'applyQuestionSupplement: applyQuestionSupplement, '
        + 'questionAnswerFor: questionAnswerFor, '
        + 'buildQuestionAnswersPayload: buildQuestionAnswersPayload'
        + '};')('s1', function () { return boxText; }, function () { calls.cleared++; });
    return { api: api, calls: calls };
}

test('行为：提交收割——已选选项 + 底部输入框打字未回车 → 选项与补充一并出站', () => {
    const { api, calls } = loadHarvest('但先别动数据库');
    const state = api.createQuestionCardState('a', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'staging' }] }]
    }));
    api.applyQuestionOptionAnswer(state, 0, 'staging');
    state.current = 0;

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].selectedLabel, 'staging', '选项必须保留');
    assert.equal(state.answers[0].supplement, '但先别动数据库');
    assert.equal(state.answers[0].custom, false, '已点选项时不得退化成自定义回答');
    assert.equal(api.buildQuestionAnswersPayload(state).answers[0].text,
        'staging（补充：但先别动数据库）');
    assert.equal(calls.cleared, 1, '收割后必须清空输入框，否则文字残留误导用户');
    assert.equal(state.current, 0, '收割不得移动光标');
});

test('行为：提交收割——未选选项时输入框文本记为自定义回答', () => {
    const { api } = loadHarvest('我自己写一个环境');
    const state = api.createQuestionCardState('b', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'staging' }] }]
    }));

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].text, '我自己写一个环境');
    assert.equal(state.answers[0].custom, true);
    assert.equal(state.answers[0].selectedLabel, '');
});

test('行为：提交收割——卡片内补充行打了字但直接点「发送」（未 Enter）', () => {
    const { api, calls } = loadHarvest('');
    const state = api.createQuestionCardState('c', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    api.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    state.drafts[0] = '草稿没回车';

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].text, 'A（补充：草稿没回车）', '未确认草稿必须折进答案');
    assert.equal(calls.cleared, 0, '输入框无内容时不得调用 clearInput');
});

test('行为：提交收割——卡片草稿与输入框文本合并，不互相覆盖', () => {
    const { api } = loadHarvest('来自输入框');
    const state = api.createQuestionCardState('d', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    api.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    state.drafts[0] = '来自卡片';

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].supplement, '来自卡片 来自输入框');
    assert.equal(state.answers[0].text, 'A（补充：来自卡片 来自输入框）');
});

test('行为：提交收割——已 Enter 确认过的补充不被后来的输入框文本覆盖', () => {
    const { api } = loadHarvest('再补一句');
    const state = api.createQuestionCardState('e', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    api.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    api.applyQuestionCustomAnswer(state, 0, '第一句');

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].supplement, '第一句 再补一句', '追加而非替换');
});

test('行为：提交收割——无新内容时不动答案、不清输入框', () => {
    const { api, calls } = loadHarvest('');
    const state = api.createQuestionCardState('f', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    api.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    const before = JSON.stringify(state.answers[0]);

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(JSON.stringify(state.answers[0]), before, '幂等：无输入不得改写答案');
    assert.equal(calls.cleared, 0);
});

test('行为：提交收割——非活动会话不得读走全局输入框内容', () => {
    const { api, calls } = loadHarvest('别的会话不该看到这句');
    const state = api.createQuestionCardState('g', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));

    api.harvestQuestionInputOnSubmit({ sessionId: 'other' }, state);

    assert.equal(state.answers[0], undefined);
    assert.equal(calls.cleared, 0, '输入框全局共享，只能收割活动会话自己的');
});

test('行为：提交收割——当前题已跳过时不得收割（X「跳过剩余直接提交」语义不被输入框残留破坏）', () => {
    const { api, calls } = loadHarvest('输入框里的残留文本');
    const state = api.createQuestionCardState('h', api.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    // 模拟 X 按钮路径：fillUnansweredAsSkipped 先跳过未答题，再提交
    state.answers[0] = sm.skippedAnswer(0);

    api.harvestQuestionInputOnSubmit({ sessionId: 's1' }, state);

    assert.equal(state.answers[0].skipped, true, '已跳过的题不得被改成自定义答案');
    assert.equal(state.answers[0].custom, false);
    assert.equal(state.answers[0].text, '');
    assert.equal(calls.cleared, 0, '未收割时不得动用户的输入框');
});

test('提交路径：handleQuestionResponse 必须在置 submitted 之前收割输入', () => {
    const submit = sliceBetween(message, 'function handleQuestionResponse', 'function applyQuestionCustomAnswerByText');
    assert.match(submit, /harvestQuestionInputOnSubmit\(sess, state\);/);
    const h = submit.indexOf('harvestQuestionInputOnSubmit');
    const s = submit.indexOf('state.submitted = true');
    assert.ok(h >= 0 && s > h, '收割必须早于提交锁，否则会被 submitted 拦住');
});

/* ===== 底部按钮三态：「跳过 / 下一步 / 发送」=====
   用户报的症状：在文本框里填了字、没点选项时，底部按钮一直写「跳过」而不是「下一步」。
   旧实现只看 questionIsAllAnswered（是否所有题都有答案），完全不看用户正在打的字。
   这不只是文案问题——点那个「跳过」会走 skipQuestionAnswer 把本题置 skipped，
   而收割函数遇到 skipped 会早退，用户打的那段字彻底丢失。 */

function mode(state, boxText) {
    return sm.questionSubmitMode(state, boxText);
}

function threeQ() {
    return sm.createQuestionCardState('m', sm.normalizeQuestionArgs({
        questions: [
            { header: 'Q1', options: [{ label: 'A' }] },
            { header: 'Q2' },
            { header: 'Q3' }
        ]
    }));
}

test('行为：按钮三态——本题无答案且无输入 = skip', () => {
    const state = threeQ();
    assert.equal(mode(state, ''), 'skip', '什么都没填时才允许显示「跳过」');
    assert.equal(mode(state, '   '), 'skip', '纯空白不算输入');
    assert.equal(mode(state, null), 'skip');
});

test('行为：按钮三态——主输入框打了字（未回车）即脱离 skip（用户报的症状）', () => {
    const state = threeQ();
    assert.equal(mode(state, '我想这样做'), 'next',
        '填了文本框就不该再显示「跳过」——点下去会丢字');
    // 单题场景：确认本题即可提交，直接给「发送」而不是无处可去的「下一步」
    const single = sm.createQuestionCardState('s', sm.normalizeQuestionArgs({
        questions: [{ header: 'Q1', options: [{ label: 'A' }] }]
    }));
    assert.equal(mode(single, '我想这样做'), 'submit');
});

test('行为：按钮三态——卡片内补充框草稿同样触发联动', () => {
    const state = threeQ();
    state.drafts[0] = '草稿';
    assert.equal(mode(state, ''), 'next', '卡内补充框的未确认草稿也是「已经打了字」');

    state.drafts[0] = '   ';
    assert.equal(mode(state, ''), 'skip', '纯空白草稿不算输入');
});

test('行为：按钮三态——与已入库补充相同的草稿不算新输入（幂等，与收割同口径）', () => {
    const state = threeQ();
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    sm.applyQuestionSupplement(state, 0, '已确认过的话');
    // applyQuestionSupplement 会把 drafts 同步成已入库值；此时无「未确认的新输入」
    assert.equal(sm.questionHasPendingInput(state, ''), false);
    // 但本题已有答案，仍应是 next（不是 skip）
    assert.equal(mode(state, ''), 'next');

    state.drafts[0] = '改了一版还没回车';
    assert.equal(sm.questionHasPendingInput(state, ''), true, '草稿与已入库值不同 = 有未确认输入');
});

test('行为：按钮三态——本题已点选项但别的题没答 = next（旧实现误显示「跳过」）', () => {
    const state = threeQ();
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    state.current = 0;
    assert.equal(mode(state, ''), 'next',
        '已答的题点「跳过」并不会真跳过（skipQuestionAnswer 只对无答案的题置 skipped），文案必须改');
});

test('行为：按钮三态——所有题有着落 = submit', () => {
    const state = threeQ();
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    sm.applyQuestionCustomAnswer(state, 1, 'x');
    sm.skipQuestionAnswer(state);          // Q3 跳过
    assert.equal(sm.questionIsAllAnswered(state), true);
    assert.equal(mode(state, ''), 'submit');
    assert.equal(mode(state, '还想再说一句'), 'submit', '全部有着落时输入框内容不改变 submit 终态');
});

test('行为：按钮三态——确认最后一道未答题时直接给 submit 而非 next', () => {
    const state = threeQ();
    sm.applyQuestionOptionAnswer(state, 0, 'A');
    sm.applyQuestionCustomAnswer(state, 1, 'x');
    state.current = 2;                      // 只剩 Q3 没答
    assert.equal(mode(state, '最后一句'), 'submit',
        '别的题都有着落时，确认本题就能提交，不该再显示「下一步」');
    assert.equal(mode(state, ''), 'skip', '最后一题什么都没填仍是「跳过」');
});

test('行为：按钮三态——已跳过的题不因输入框残留而复活（尊重放弃意图）', () => {
    const state = threeQ();
    state.answers[0] = sm.skippedAnswer(0);
    state.current = 0;
    assert.equal(sm.questionHasPendingInput(state, '输入框里的残留'), false,
        '已明确跳过的题，输入框残留不得被视作待确认输入（与收割函数早退口径一致）');
    // 本题已有状态（skipped），故不是 skip 态；Q2/Q3 未答故为 next
    assert.equal(mode(state, '输入框里的残留'), 'next');
});

test('行为：questionOthersAllAnswered 只检查除当前题外的其它题', () => {
    const state = threeQ();
    assert.equal(sm.questionOthersAllAnswered(state, 0), false);
    sm.applyQuestionCustomAnswer(state, 1, 'x');
    sm.applyQuestionCustomAnswer(state, 2, 'y');
    assert.equal(sm.questionOthersAllAnswered(state, 0), true, '本题无答案不影响「其它题都已有着落」的判定');
    assert.equal(sm.questionIsAllAnswered(state), false);
});

test('行为：「下一步」在末题作答时不得卡死（环绕找下一道待办题）', () => {
    const state = threeQ();
    // 用户直接翻到最后一题作答，Q1/Q2 还空着
    state.current = 2;
    sm.applyQuestionOptionAnswer(state, 2, 'C');
    assert.equal(state.current, 2, 'advanceQuestionCursor 在末题是空操作（卡死的前提）');
    assert.equal(sm.questionSubmitMode(state, ''), 'next', '本题已答、别题未答 → next');
    assert.equal(sm.nextUnansweredQuestionIndex(state, state.current), 0,
        '必须环绕回到 Q1，否则「下一步」永远点不动');
});

test('行为：nextUnansweredQuestionIndex 跳过已有状态的题，全有着落时返回 -1', () => {
    const state = threeQ();
    assert.equal(sm.nextUnansweredQuestionIndex(state, 0), 1, '相邻待办题');
    state.answers[1] = sm.skippedAnswer(1);          // 已跳过也算「有着落」，不得回头
    assert.equal(sm.nextUnansweredQuestionIndex(state, 0), 2);
    sm.applyQuestionCustomAnswer(state, 2, 'y');
    sm.applyQuestionCustomAnswer(state, 0, 'x');
    assert.equal(sm.nextUnansweredQuestionIndex(state, 0), -1, '全部有着落 → -1（此时 mode 已是 submit）');
});

test('渲染/点击：按钮文案与 data-mode 同源于 questionSubmitMode，点击按 mode 分派', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /questionSubmitMode\(state, currentInputBoxText\(sess\)\)/,
        '渲染必须用三态判定，不得退回 allAnswered 二元式');
    assert.match(render, /data-mode="/, '按钮须落 data-mode 供点击处理器读取');
    assert.match(render, /QUESTION_SUBMIT_MODE_KEYS\[mode\]/);
    assert.doesNotMatch(render, /allAnswered \? 'chat\.question_submit' : 'chat\.question_skip'/,
        '旧的两态文案三元式必须已移除');

    const keys = sliceBetween(message, 'var QUESTION_SUBMIT_MODE_KEYS', 'function currentInputBoxText');
    assert.match(keys, /skip: 'chat\.question_skip'/);
    assert.match(keys, /next: 'chat\.question_next'/);
    assert.match(keys, /submit: 'chat\.question_submit'/);

    const click = sliceBetween(message, "$(host).on('click', '.question-card-submit'", '/* 当前活动会话的问答状态');
    assert.match(click, /questionSubmitMode\(st, currentInputBoxText\(sess\)\)/,
        '点击须实时重算，不能只信可能过期的 data-mode 快照');
    assert.match(click, /mode === 'submit'/);
    assert.match(click, /mode === 'next'/);
    // next 分支必须先收割再推进，否则「下一步」会把用户刚打的字丢在输入框里
    const nextIdx = click.indexOf("mode === 'next'");
    const harvestIdx = click.indexOf('harvestQuestionInputOnSubmit', nextIdx);
    const advanceIdx = click.indexOf('advanceQuestionCursor', nextIdx);
    assert.ok(nextIdx >= 0 && harvestIdx > nextIdx && advanceIdx > harvestIdx,
        'next 分支必须「先收割输入、再推进光标」');
});

test('联动：两个输入面都刷新按钮文案，且只改按钮不重建卡片', () => {
    // ① 卡片内补充框
    const cardInput = sliceBetween(message, "$(host).on('input', '.question-card-other-input'", "$(host).on('keydown'");
    assert.match(cardInput, /refreshQuestionSubmitLabel\(\)/);

    // ② 底部主输入框（app-ui.js）
    const chatBind = sliceBetween(ui, "$(chatInput).on('input'", '/* ===== Input box height drag adjustment');
    assert.match(chatBind, /refreshQuestionSubmitLabel/,
        '主输入框也是合法作答入口，打字必须联动按钮文案');
    assert.match(chatBind, /typeof window\.refreshQuestionSubmitLabel === 'function'/,
        '须做存在性判定，避免脚本加载顺序造成报错');

    // 刷新函数只改按钮，不得整卡重建（否则用户在卡内打字时焦点与光标会被打断）
    const refresh = sliceBetween(message, 'function refreshQuestionSubmitLabel', 'window.refreshQuestionSubmitLabel =');
    assert.match(refresh, /\.question-card-submit/);
    assert.match(refresh, /btn\.textContent =/);
    assert.doesNotMatch(refresh, /syncQuestionCard|renderQuestionCard|innerHTML/,
        '轻量刷新不得重建卡片，否则会打断正在输入的用户');

    // 主输入框全局共享：非活动会话的卡不得读走别人正在打的字
    const boxText = sliceBetween(message, 'function currentInputBoxText', 'function refreshQuestionSubmitLabel');
    assert.match(boxText, /sess\.sessionId !== activeSessionId/);
});
