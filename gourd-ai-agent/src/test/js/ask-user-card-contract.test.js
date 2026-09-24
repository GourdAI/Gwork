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
/* question_other（「以上都不合适？自己输入回答…」静态入口行文案）已随「常驻输入框」改造退役：
   输入框现在总是可见，不再需要「点击才变输入框」的入口行。键仍保留在语言包里（存量资产，
   删除需同时动 12 个文件且与本主题无关），但不再列入必需键。 */
const QUESTION_KEYS = ['question_waiting', 'question_other_placeholder', 'question_skip',
    'question_next', 'question_submit', 'question_recommended', 'question_answered', 'question_skipped',
    'question_close', 'question_attachment_wait', 'question_supplement', 'question_supplement_placeholder',
    'question_detail_expand', 'question_detail_collapse', 'question_record_title'];

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
    'questionTextLen: questionTextLen, ' +
    'splitQuestionLabel: splitQuestionLabel, ' +
    'stripQuestionRecoWord: stripQuestionRecoWord, ' +
    'questionOptionView: questionOptionView, ' +
    'questionDetailShouldCollapse: questionDetailShouldCollapse, ' +
    'formatQuestionAnswerForRecord: formatQuestionAnswerForRecord, ' +
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
    assert.match(message, /function syncQuestionCard\(\)/);
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

test('12 个语言包均提供 15 个 chat.question_* 键与问答挂起 placeholder 键（JSON 合法、行尾无裸 LF）', () => {
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

test('app-message.js：补充输入框常驻渲染（不再需要「点击才变输入框」），placeholder 用专用键', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /GourdI18n\.t\('chat\.question_other_placeholder'\)/, '未选选项时 placeholder 用 question_other_placeholder');
    assert.match(render, /GourdI18n\.t\('chat\.question_supplement_placeholder'\)/, '已选选项时 placeholder 切换为补充语义');
    /* 旧设计是「静态入口行 → 点击才渲染 input」（otherEditing 门控），取证显示这条路径多一步操作
       且入口不显眼——用户选完选项想补一句时根本不知道还能打字。改为未提交即常驻 input。 */
    assert.match(render, /if \(!submitted\) \{[\s\S]*question-card-other-row is-editing/,
        '未提交时必须直接渲染编辑态输入框');
    assert.doesNotMatch(render, /state\.otherEditing && !submitted/,
        '旧的 otherEditing 门控渲染分支必须已移除（否则又变回「点击才出现」）');
    assert.doesNotMatch(render, /GourdI18n\.t\('chat\.question_other'\)/,
        'question_other 静态入口行文案已退役，不得再出现在渲染里');
});

test('app-message.js：长 detail 默认折叠 + 展开按钮（取证 p50=115 字、p90=280，不折叠会把选项顶出屏）', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /questionDetailShouldCollapse\(q\.detail\)/, '折叠判定必须复用纯函数口径');
    assert.match(render, /state\.detailOpen\[idx\]/, '展开态必须记在 state 上（整卡重建不丢）');
    assert.match(render, /question-card-detail-toggle/, '必须渲染展开/收起按钮');
    assert.match(render, /chat\.question_detail_expand/);
    assert.match(render, /chat\.question_detail_collapse/);
    assert.match(render, /aria-expanded=/, '折叠按钮须暴露展开态供读屏器使用');

    const events = sliceBetween(message, 'function bindQuestionCardEvents', 'function activeQuestionCardState');
    assert.match(events, /\$\(host\)\.on\('click', '\.question-card-detail-toggle'/, '展开按钮必须挂委托事件');
    assert.match(events, /st\.detailOpen\[qi\] = !st\.detailOpen\[qi\];/, '点击必须切换展开态');
});

test('app-message.js / app.css：选项渲染为「短标题 + 推荐胶囊 + 灰色说明」，选中判定仍用原始 label', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');
    assert.match(render, /var view = questionOptionView\(o\);/, '必须经整形视图渲染');
    assert.match(render, /questionOptionSelected\(state, idx, view\.label\)/,
        '选中判定必须传【原始 label】：整形只影响展示，否则高亮与出站答案会对不上');
    assert.match(render, /question-card-opt-title/);
    assert.match(render, /view\.desc \? '<span class="question-card-opt-desc">'/, '有说明才渲染说明行');
    assert.match(render, /question-card-opt-reco/);
    assert.doesNotMatch(render, /escapeHtml\(o\.label == null \? '' : o\.label\)/,
        '不得再把整段原始 label 直接渲染成一行（这正是「选个选项得看半天」的成因）');

    // 点击仍按原始 label 落答案（出站协议零改动）
    const events = sliceBetween(message, 'function bindQuestionCardEvents', 'function activeQuestionCardState');
    assert.match(events, /applyQuestionOptionAnswer\(st, qi, opt\.label\)/);

    assert.match(appCss, /\.question-card-opt-title \{/);
    assert.match(appCss, /\.question-card-opt-desc \{/);
    assert.match(appCss, /\.question-card-opt-main \{/);
    assert.match(appCss, /\.question-card-opt-reco \{[^}]*border-radius: 999px/, '推荐标记必须是胶囊而非灰色括号文本');
    assert.match(appCss, /\.question-card-options \{[^}]*max-height/, '选项区必须限高滚动');
    /* 整卡限高：断言「行为」（.question-card 规则内含 max-height + overflow-y）而非
       「首属性顺序」（旧写法 /\.question-card \{ max-height:/ 把属性必须排在第一个当契约，
       合并重复选择器后就误报）。选择器写法可以变，弹层不得吞掉对话区这个约束不能丢。 */
    const cardRule = (appCss.match(/\.question-card\s*\{[^}]*\}/) || [''])[0];
    assert.match(cardRule, /max-height:/, '整卡必须限高，弹层不得吞掉对话区');
    assert.match(cardRule, /overflow-y:\s*auto/, '整卡限高后必须可内部滚动，否则超限内容被裁掉看不到');
    /* 选项说明默认限高渐隐、选中即展开：这是「选个选项得看半天」的直接解药，
       折叠态限 max-height 而 .selected 解除（max-height: none），信息可完整取回。 */
    const descRule = (appCss.match(/\.question-card-opt-desc\s*\{[^}]*\}/) || [''])[0];
    assert.match(descRule, /max-height:/, '选项说明必须默认限高，长说明不得撑满整行');
    assert.match(appCss, /\.question-card-option\.selected \.question-card-opt-desc\s*\{[^}]*max-height:\s*none/,
        '选中选项后说明必须自动展开（折叠只为扫读，不得让用户看不到自己选中项的完整依据）');
    /* 【渐隐遮罩的百分比陷阱】mask 的 mask-image 里若用 calc(100% - Npx)，100% 是相对
       【元素自身高度】的：一行说明高约 17px，渐隐起点就变成 3px，整行被渐隐掉八成，
       看起来像渲染坏了——而实测大多数说明恰好只有 1 行，等于普遍中招。
       故断言：渐隐终点必须钉在「第 3 行底部」的绝对 em 长度（3 * 1.45em），
       不得用 100%。短说明时渐隐区落在可见范围外（零影响），长说明被 max-height 裁住时
       渐隐恰在可见区底部。这是纯 CSS 解法，无需 JS 预判行数。
       （对照：.steer-note/.question-card-detail 能用 100% 是因为它们的 mask 只在 JS 确认
       溢出的 .collapsed 态才生效，而 opt-desc 的限高是无条件的，两者前提不同。） */
    assert.match(descRule, /mask-image:\s*linear-gradient\([^)]*calc\(3 \* 1\.45em/,
        '渐隐遮罩必须用绝对 em 长度钉在第 3 行底部，不得用 100%（否则短说明会被整体渐隐掉）');
    assert.doesNotMatch(descRule, /mask-image:\s*linear-gradient\([^)]*calc\(100%/,
        '渐隐遮罩的 calc 里禁用 100%：mask 百分比相对元素自身高度，一行说明会被渐隐掉大部分');
});

test('app-message.js：作答闭环后在内容区落一条问答记录（弹层消失不等于凭据消失）', () => {
    assert.match(message, /function appendQuestionAnswerRecord\(sess, state, chunk\)/);
    assert.match(message, /window\.appendQuestionAnswerRecord = appendQuestionAnswerRecord;/);

    const answered = sliceBetween(message, 'function handleQuestionAnsweredFrame', '/* 按当前活动会话的问答状态同步卡片');
    assert.match(answered, /appendQuestionAnswerRecord\(sess, st, chunk\)/);
    const recIdx = answered.indexOf('appendQuestionAnswerRecord');
    const clearIdx = answered.indexOf('sess._questionState = null;');
    assert.ok(recIdx >= 0 && clearIdx > recIdx,
        '必须先落记录再清状态：question_answered 帧只有 answers，题面只能从 state 取');

    const rec = sliceBetween(message, 'function appendQuestionAnswerRecord', 'window.appendQuestionAnswerRecord');
    // 帧里没有题面 → 只能取自 state，且必须校验 actionId 一致，否则会把 A 的题面安到 B 的答案上
    assert.match(rec, /state\.actionId === actionId/);
    assert.match(rec, /var questions = \(state && actionId && state\.actionId === actionId\) \? state\.questions : null;/);
    // 幂等：回放、他端作答、提交失败重试都可能重复触发同一帧
    assert.match(rec, /\.qa-record\[data-action-id=/, '必须按 actionId 去重');
    assert.match(rec, /if \(!Array\.isArray\(answers\) \|\| answers\.length === 0\) return;/, '空答案不得落空卡');
    assert.match(rec, /formatQuestionAnswerForRecord\(q, item\)/);
    assert.match(rec, /insertBeforeActions\(sess, el\)/, '必须走 HITL 卡同一条插入范式（落在气泡内、页脚之上）');
    assert.match(rec, /advanceBodyPointer/, '必须推进正文指针，后续 AI 正文不得回灌进上一个气泡');
    assert.match(rec, /isDetachedRenderTarget\(sess\)/, '回放渲染到游离容器时不得滚动');
    // 记录渲染失败不得连带把问答卡弄没（包 try 在调用方 handleQuestionAnsweredFrame 里）
    assert.match(answered, /try \{ appendQuestionAnswerRecord/, '落记录必须包 try，渲染异常不得中断收卡与后续帧');

    assert.match(appCss, /\.qa-record \{/);
    assert.match(appCss, /\.qa-record-q \{/);
    assert.match(appCss, /\.qa-record-a \{/);
    assert.match(appCss, /\.qa-record-a\.skipped/);
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

/* ===== 选项整形：把「标题：解释」长 label 拆成可扫读的短标题 + 说明 =====
   取证口径（146 会话 / 66 卡 / 142 题 / 419 选项）：label 中位 40 字、p90 111、最长 321，
   379/419（90%）是标题与解释混塞，80 个 label 自带「推荐」字样而 recommended 又为真。
   以下用例全部取自真实会话样本，不是理想构造。 */

test('行为：整形——「标题：解释」长 label 拆为短标题 + 说明（真实 top 样本）', () => {
    const v = sm.questionOptionView({
        label: 'A｜最小修复：只重写 AskUserTool 的工具描述——删掉抑制条款。改动 1 个文件 + 定向测试。优点：零风险；缺点：治标'
    });
    assert.equal(v.title, 'A｜最小修复', '取最靠前的合格分隔点，标题尽量短');
    assert.ok(sm.questionTextLen(v.title) <= 24);
    assert.match(v.desc, /^只重写 AskUserTool/);
    assert.ok(v.desc.includes('优点'), '说明不得丢信息');
});

test('行为：整形——取最靠前的分隔点，标题内部的逗号/括号不得被劈碎', () => {
    // 真实样本：冒号在括号之后，括号内含逗号——按逗号劈会把标题切碎
    const v = sm.questionOptionView({
        label: '方案一 · 止血（最小改动，约 2 个文件）：doStream 持有 future 并挂 whenComplete'
    });
    assert.equal(v.title, '方案一 · 止血（最小改动，约 2 个文件）');
    assert.equal(v.desc, 'doStream 持有 future 并挂 whenComplete');
    assert.ok(!v.title.includes('doStream'), '说明不得被当成标题的一部分');
});

test('行为：整形——3 字标题（「方案A——…」）必须能拆，不得因下限过大而整段不拆', () => {
    const v = sm.questionOptionView({
        label: '方案A——回放调度与流状态解耦 + 看门狗自愈，覆盖三类故障'
    });
    assert.equal(v.title, '方案A', '「方案A」是取证里的高频合法标题，下限 4 会把它拒掉');
    assert.equal(v.desc, '回放调度与流状态解耦 + 看门狗自愈，覆盖三类故障');
});

test('行为：整形——短 label 不拆；无分隔符的纯长句绝不硬截断', () => {
    assert.deepEqual(
        sm.questionOptionView({ label: '方案C：前端超时兜底' }),
        { title: '方案C', desc: '前端超时兜底', label: '方案C：前端超时兜底' });
    // 找不到合格分隔点时整段作标题：宁可换行，也不能把语义从中间切断
    const long = '直接采用官方 HttpClient 传输并彻底移除 1051 行定制代码';
    const v = sm.questionOptionView({ label: long });
    assert.equal(v.title, long);
    assert.equal(v.desc, '');
    assert.equal(v.label, long);
});

test('行为：整形——模型已给 description 时直接采用，绝不改动 label', () => {
    const v = sm.questionOptionView({
        label: '方案A：最小修复', description: '只改一个文件，风险最低但治标', recommended: true
    });
    assert.equal(v.desc, '只改一个文件，风险最低但治标', 'description 优先，不得再按 label 兜底拆分');
    assert.equal(v.label, '方案A：最小修复', '出站 label 必须保持原样');
    // detail 是模型自发用过的别名（取证：419 个选项里 3 个），一并收下
    assert.equal(sm.questionOptionView({ label: 'X', detail: '别名说明' }).desc, '别名说明');
});

test('行为：整形——normalizeQuestionArgs 不再丢弃 description/detail（旧实现惩罚了最规范的调用）', () => {
    const qs = sm.normalizeQuestionArgs({
        questions: [{
            header: 'H', detail: 'D',
            options: [
                { label: 'A', description: '说明一', recommended: true },
                { label: 'B', detail: '别名说明' },
                { label: 'C' }
            ]
        }]
    });
    assert.equal(qs[0].options[0].description, '说明一');
    assert.equal(qs[0].options[0].recommended, true);
    assert.equal(qs[0].options[1].description, '别名说明', 'detail 别名必须被收下');
    assert.equal(qs[0].options[2].description, '', '未给时归一为空串');
    assert.equal(qs[0].options[2].label, 'C');
});

test('行为：整形——推荐字样去重（标题与说明都不得再出现「推荐」，胶囊统一表达）', () => {
    // 形态一：标题尾部带「（推荐）」（真实样本）
    const a = sm.questionOptionView({ label: '方案B：补齐信号源 + 相位映射，根治（推荐）', recommended: true });
    assert.equal(a.title, '方案B');
    assert.equal(a.desc, '补齐信号源 + 相位映射，根治', '说明末尾的「（推荐）」必须剥掉');
    assert.ok(!/推荐/.test(a.title + a.desc), '推荐只能由胶囊表达一次');

    // 形态二：标题被剥塌 → 从说明首句补位（真实样本，旧实现会塌成 1 字标题「B」）
    const b = sm.questionOptionView({ label: 'B｜推荐：提示词硬规则 + A。在 ReActSystemPromptCn/En 里新增硬约束', recommended: true });
    assert.ok(sm.questionTextLen(b.title) >= 2, '标题不得塌成单字');
    assert.equal(b.title, '提示词硬规则 + A');
    assert.equal(b.desc, '在 ReActSystemPromptCn/En 里新增硬约束', '补位后剩余说明继续作 desc，信息不丢');

    // 对照：recommended 为假时不得剥「推荐」——那是正文语义，剥掉会改变含义
    const c = sm.questionOptionView({ label: '方案X：采纳社区推荐的默认配置' });
    assert.ok(c.desc.includes('推荐'), '未标记 recommended 时「推荐」是正文，必须保留');
    // 「建议」是正文语义（如「采纳建议」），任何情况下都不剥
    const d = sm.questionOptionView({ label: '方案Y：按评审建议重构', recommended: true });
    assert.ok((d.title + d.desc).includes('建议'));
});

test('行为：整形——detail 折叠判定按字数与行数双口径', () => {
    assert.equal(sm.questionDetailShouldCollapse(''), false, '空说明不折叠');
    assert.equal(sm.questionDetailShouldCollapse('   '), false);
    assert.equal(sm.questionDetailShouldCollapse('这是一段不长的说明文字。'), false);
    assert.equal(sm.questionDetailShouldCollapse('实'.repeat(121)), true, '取证 detail p50=115，阈值 120');
    assert.equal(sm.questionDetailShouldCollapse('a\nb\nc'), false, '3 行以内不折叠');
    assert.equal(sm.questionDetailShouldCollapse('a\nb\nc\nd'), true);
});

test('行为：问答记录整形——选中/补充/跳过/自定义四种形态', () => {
    const q = { header: 'Q', options: [{ label: 'A｜最小修复：只改一个文件' }] };
    // ① 纯选中：用短标题 + 说明呈现，不是把 321 字原文糊上去
    assert.deepEqual(sm.formatQuestionAnswerForRecord(q, { text: 'A｜最小修复：只改一个文件', skipped: false, custom: false }),
        { skipped: false, title: 'A｜最小修复', desc: '只改一个文件', supplement: '', custom: false });
    // ② 选中 + 补充：补充单独拎出来，不得与标题混成一行长文
    assert.deepEqual(sm.formatQuestionAnswerForRecord(q, { text: 'A｜最小修复：只改一个文件（补充：但先别动库）', skipped: false, custom: false }),
        { skipped: false, title: 'A｜最小修复', desc: '只改一个文件', supplement: '但先别动库', custom: false });
    // ③ 跳过
    assert.deepEqual(sm.formatQuestionAnswerForRecord(q, { text: '', skipped: true }),
        { skipped: true, title: '', desc: '', supplement: '', custom: false });
    // ④ 自定义：原样呈现，不得被整形
    assert.deepEqual(sm.formatQuestionAnswerForRecord(q, { text: '我自己写的方案', skipped: false, custom: true }),
        { skipped: false, title: '我自己写的方案', desc: '', supplement: '', custom: true });
});

test('行为：问答记录整形——题面缺失（回放隔离导致 state 不同题）时退回原文，绝不丢答案', () => {
    const raw = 'A｜最小修复：只改一个文件（补充：别动库）';
    // q 为 null：question_answered 帧只有 answers，题面可能因 actionId 不一致而不可用
    assert.deepEqual(sm.formatQuestionAnswerForRecord(null, { text: raw, skipped: false, custom: false }),
        { skipped: false, title: raw, desc: '', supplement: '', custom: true },
        '反查不到选项时按自定义原样呈现——宁可少题面，不可丢用户的回答');
    // 选项列表为空 / text 与任何 label 都不匹配，同样退回原文
    assert.equal(sm.formatQuestionAnswerForRecord({ header: 'Q', options: [] }, { text: raw }).title, raw);
    assert.equal(sm.formatQuestionAnswerForRecord({ header: 'Q', options: [{ label: '别的选项' }] }, { text: raw }).title, raw);
    // 空白文本等同跳过（与后端 formatAnswerText 的口径一致）
    assert.equal(sm.formatQuestionAnswerForRecord(null, { text: '   ' }).skipped, true);
});

/* ===== 焦点/视野恢复（输入框常驻化引入的真实回归，见下） =====

   背景：旧版补充说明是「静态入口行 → 点击才渲染 input」，由 otherEditing 门控；
   本次改成常驻输入框后，补焦的唯一调用方（传 focusOther 的那条点击路径）被删除，
   而整卡是 host.innerHTML 全量重建 —— 于是敲 Enter 提交补充、或点选任一选项后，
   聚焦元素随 DOM 一起被销毁，焦点掉回 body：用户既不能接着打字，也失去键盘导航能力。
   以下断言覆盖该回归的三条不变量。 */
test('行为：焦点 key 忽略状态类——点选后加上 selected 仍必须匹配回同一元素', () => {
    /* questionCardFocusKeyOf 是纯函数（只读 tagName/className/attributes，不碰 document），
       但它位于 DOM 渲染区、不在状态机 sm 块内，故单独提取。 */
    const block = sliceBetween(message, 'var QUESTION_CARD_VOLATILE_CLASS', '/* 当前聚焦元素的 key');
    const { questionCardFocusKeyOf } = new Function(block + '\nreturn { questionCardFocusKeyOf };')();

    /* 最小 element stub：只给被测函数读到的三个属性 */
    const el = (tag, cls, dataAttrs) => ({
        nodeType: 1, tagName: tag, className: cls,
        attributes: Object.keys(dataAttrs || {}).map(k => ({ name: k, value: dataAttrs[k] }))
    });

    // ① 选中前 / 选中后（多了 selected 类）：key 必须完全相同
    const before = el('BUTTON', 'question-card-option', { 'data-q-index': '0', 'data-opt-index': '2' });
    const after = el('BUTTON', 'question-card-option selected', { 'data-q-index': '0', 'data-opt-index': '2' });
    assert.equal(questionCardFocusKeyOf(before), questionCardFocusKeyOf(after),
        '状态类不得进 key：点选选项后类名会变，若算进去就永远匹配不上，焦点恢复恰在最该生效的场景失效');

    // ② is-editing / collapsed / disabled / 入场动画类同理（均为状态而非身份）
    const editing = el('DIV', 'question-card-other-row is-editing', {});
    const notEditing = el('DIV', 'question-card-other-row', {});
    assert.equal(questionCardFocusKeyOf(editing), questionCardFocusKeyOf(notEditing));
    assert.equal(questionCardFocusKeyOf(el('DIV', 'question-card-detail collapsed', {})),
        questionCardFocusKeyOf(el('DIV', 'question-card-detail', {})));
    assert.equal(questionCardFocusKeyOf(el('DIV', 'question-card question-card-enter', {})),
        questionCardFocusKeyOf(el('DIV', 'question-card', {})));

    // ③ 身份必须可区分：同 tag 同基类但 data-opt-index 不同 → key 不同（否则焦点会串到别的选项）
    const opt1 = el('BUTTON', 'question-card-option', { 'data-opt-index': '1' });
    const opt2 = el('BUTTON', 'question-card-option', { 'data-opt-index': '2' });
    assert.notEqual(questionCardFocusKeyOf(opt1), questionCardFocusKeyOf(opt2),
        'data-* 必须进 key：同层级同类名的兄弟元素只能靠它区分');
    assert.notEqual(questionCardFocusKeyOf(opt1), questionCardFocusKeyOf(el('BUTTON', 'question-card-prev', {})));

    // ④ 防御：非元素 / 空 className / 无 attributes 都不得抛错
    assert.equal(questionCardFocusKeyOf(null), '');
    assert.equal(questionCardFocusKeyOf({ nodeType: 3 }), '');
    assert.equal(questionCardFocusKeyOf(el('INPUT', '  ', {})), 'INPUT');
});

test('源码契约：重建前取现场、重建后恢复，且焦点恢复不依赖调用方传参', () => {
    const render = sliceBetween(message, '/* 渲染卡片到宿主', 'function handleQuestionResponse');

    /* ① 取现场必须在 host.innerHTML 之前，恢复必须在其之后（顺序颠倒就等于没恢复） */
    const wipeIdx = render.indexOf('host.innerHTML = html;');
    assert.ok(wipeIdx > 0, '必须保留整卡重建语句');
    const grabIdx = render.indexOf('questionCardFocusKeyIn(host)');
    const restoreIdx = render.indexOf('questionCardRestoreView(host');
    assert.ok(grabIdx > 0 && grabIdx < wipeIdx, '重建前必须记下焦点元素（innerHTML 一旦执行，旧元素连同焦点一起销毁）');
    assert.ok(restoreIdx > wipeIdx, '重建后必须恢复焦点');

    /* ② 关键回归护栏：恢复必须是无条件的。旧实现只在 opts.focusOther 为真时补焦，
       而常驻化后没人再传该参数 → 每次重建都掉焦点。 */
    assert.ok(render.indexOf('syncQuestionCard({ focusOther: true })') < 0,
        '不得再依赖调用方显式传 focusOther 才能保住焦点');
    assert.match(render, /questionCardRestoreView\(host, key, caret, scroll\)/);

    /* ③ 光标与滚动现场同样要恢复：重建会销毁 selection 与两个限高容器的 scrollTop */
    assert.ok(render.indexOf('questionCardCaretIn(host)') < wipeIdx, '重建前必须记光标区间（否则 Enter 后无法续写）');
    assert.ok(render.indexOf('questionCardScrollSnapshot(host)') < wipeIdx, '重建前必须记滚动位置');

    /* ④ 滚动恢复必须在 focus() 之后：focus 自带滚动副作用，先设 scrollTop 会被它顶掉 */
    const restoreFn = sliceBetween(message, 'function questionCardRestoreView', '/* 提交全部答案');
    const focusIdx = restoreFn.indexOf('.focus()');
    const scrollIdx = restoreFn.indexOf('scrollTop = scroll.card');
    assert.ok(focusIdx > 0 && scrollIdx > focusIdx, '滚动恢复必须排在 focus() 之后，否则被 focus 的滚动副作用覆盖');

    /* ⑤ 光标恢复必须夹在 value 长度内：重建后输入框长度可能已变，越界会被浏览器静默丢弃或抛错 */
    assert.match(restoreFn, /Math\.min\(caret\.start, max\)/);
    assert.match(restoreFn, /Math\.min\(caret\.end, max\)/);
});

test('源码契约：常驻化后不得留下 otherEditing 死代码', () => {
    /* otherEditing 是旧「点击才渲染输入框」的门控开关；输入框常驻后它已无任何读取点，
       残留只会误导后续维护者以为还存在两种形态。 */
    assert.doesNotMatch(message, /otherEditing/,
        'otherEditing 已无读取点，必须整体清除（12 处赋值全部是死代码）');
    assert.doesNotMatch(appCss, /question-card-other-row\[role="button"\]/,
        '静态入口行形态已移除，其 role="button" 的 CSS 无宿主，必须一并删除');
    assert.ok(!Object.prototype.hasOwnProperty.call(sm.createQuestionCardState('x', []), 'otherEditing'),
        '状态对象不得再携带 otherEditing 字段');
    assert.ok(Object.prototype.hasOwnProperty.call(sm.createQuestionCardState('x', []), 'detailOpen'),
        'detailOpen 折叠态必须入状态（否则勾选/翻页整卡重建后展开态丢失）');
});

/* ===== 焦点恢复的真实行为测试 =====

   上面的「源码契约」只能证明代码写了恢复调用，证明不了恢复真的生效（比如 key 算错就
   永远匹配不上）。本组用微型 DOM 桩跑【真实函数】，复现回归场景本身。 */
function createFocusSandbox(opts) {
    opts = opts || {};
    const dom = { body: {}, activeElement: null };
    const els = [];
    let card = null, list = null;

    function makeEl(tag, cls, o) {
        o = o || {};
        const el = {
            nodeType: 1,
            tagName: tag,
            className: cls || '',
            attributes: Object.keys(o.data || {}).map(k => ({ name: k, value: String(o.data[k]) })),
            value: o.value || '',
            /* selectionStart 默认给数字（真 input 如此）；非输入元素给 null，
               被测代码靠 typeof === 'number' 区分是否该恢复光标 */
            selectionStart: (o.noCaret ? null : (o.selStart != null ? o.selStart : 0)),
            selectionEnd: (o.noCaret ? null : (o.selEnd != null ? o.selEnd : 0)),
            scrollTop: o.scrollTop || 0,
            selCalls: [],
            focused: false,
            focus() {
                el.focused = true;
                dom.activeElement = el;
                /* 模拟浏览器 focus() 的滚动副作用：会把容器滚到元素可见位置。
                   只有标记了 focusResetsScroll 的元素才模拟，用于验证「滚动恢复必须
                   排在 focus() 之后」——顺序颠倒会被 focus 的副作用静默顶掉。 */
                if (o.focusResetsScroll) { if (card) card.scrollTop = 0; if (list) list.scrollTop = 0; }
            },
            setSelectionRange(a, b) { el.selCalls.push([a, b]); el.selectionStart = a; el.selectionEnd = b; },
            blur() { el.focused = false; if (dom.activeElement === el) dom.activeElement = dom.body; }
        };
        if (o.as === 'card') card = el;
        if (o.as === 'list') list = el;
        els.push(el);
        return el;
    }
    function makeHost() {
        return {
            contains: (e) => els.indexOf(e) >= 0,
            querySelector(sel) {
                if (sel === '.question-card') return card;
                if (sel === '.question-card-options') return list;
                if (sel === '.question-card-other-input') {
                    for (const e of els) { if ((e.className || '').indexOf('question-card-other-input') >= 0) return e; }
                }
                return null;
            },
            querySelectorAll(sel) {
                assert.equal(sel, 'input, textarea, button, [tabindex]', '候选集必须是可聚焦元素');
                return els.slice();
            }
        };
    }
    /* 重置为「重建后」的新 DOM：旧元素全部丢弃（innerHTML 全量重建的真实后果） */
    function rebuild(specs) {
        els.length = 0; card = null; list = null; dom.activeElement = dom.body;
        const made = specs.map(s => makeEl(s.tag, s.cls, s));
        return { host: makeHost(), els: made };
    }
    const block = sliceBetween(message, 'var QUESTION_CARD_VOLATILE_CLASS', '/* 提交全部答案');
    const api = new Function('document', block + '\nreturn {' +
        'questionCardFocusKeyOf: questionCardFocusKeyOf, ' +
        'questionCardFocusKeyIn: questionCardFocusKeyIn, ' +
        'questionCardCaretIn: questionCardCaretIn, ' +
        'questionCardScrollSnapshot: questionCardScrollSnapshot, ' +
        'questionCardRestoreView: questionCardRestoreView };')(dom);
    return { api, dom, makeEl, makeHost, rebuild, els: () => els };
}

test('行为：重建后焦点真的回到同一元素（复现并验证本次修复的回归）', () => {
    const sb = createFocusSandbox();
    /* 重建前：用户正在补充说明输入框里打字，光标停在中间 */
    const input = sb.makeEl('INPUT', 'question-card-other-input', { value: '先止血', selStart: 1, selEnd: 3 });
    const host = sb.makeHost();
    sb.dom.activeElement = input;

    const key = sb.api.questionCardFocusKeyIn(host);
    const caret = sb.api.questionCardCaretIn(host);
    const scroll = sb.api.questionCardScrollSnapshot(host);
    assert.ok(key, '焦点在卡内时必须取到 key（取不到就等于放弃恢复）');
    assert.deepEqual(caret, { start: 1, end: 3 }, '光标区间必须现场快照');

    /* 重建后：全新元素，且本题已选中选项→选项按钮多了 selected 类。
       注意类名层级必须对齐真实渲染（renderQuestionCard）：is-editing 挂在【父 div
       .question-card-other-row】上，而 input 自身的类恒为 question-card-other-input ——
       这正是焦点能跨重建匹配上的原因：key 只取元素自身的类，父层状态变化不影响它。 */
    const rebuilt = sb.rebuild([
        { tag: 'BUTTON', cls: 'question-card-option selected', data: { 'data-opt-index': '1' }, noCaret: true },
        { tag: 'INPUT', cls: 'question-card-other-input', value: '先止血' }
    ]);
    const newInput = rebuilt.els[1];
    assert.equal(newInput.focused, false, '重建后新元素初始无焦点（innerHTML 重建必然如此）');

    sb.api.questionCardRestoreView(rebuilt.host, key, caret, scroll);

    assert.equal(newInput.focused, true, '【回归护栏】重建后焦点必须回到同一输入框，否则敲 Enter 后无法续写');
    assert.deepEqual(newInput.selCalls, [[1, 3]], '光标区间必须原样恢复，用户接着打字不得从头开始');
    assert.equal(sb.dom.activeElement, newInput);
});

test('行为：点选选项后焦点不丢（旧实现靠 focusOther 显式补焦，常驻化后已无人传参）', () => {
    const sb = createFocusSandbox();
    const btn = sb.makeEl('BUTTON', 'question-card-option', { data: { 'data-q-index': '0', 'data-opt-index': '2' }, noCaret: true });
    const host = sb.makeHost();
    sb.dom.activeElement = btn;

    const key = sb.api.questionCardFocusKeyIn(host);
    const caret = sb.api.questionCardCaretIn(host);
    assert.equal(caret, null, '按钮无光标语义，caret 必须为 null（否则会被当成数字误用）');

    /* 点选后重建：同一按钮多了 selected 类 */
    const rebuilt = sb.rebuild([
        { tag: 'BUTTON', cls: 'question-card-option', data: { 'data-q-index': '0', 'data-opt-index': '1' }, noCaret: true },
        { tag: 'BUTTON', cls: 'question-card-option selected', data: { 'data-q-index': '0', 'data-opt-index': '2' }, noCaret: true }
    ]);
    /* 证明恢复是无条件的：不依赖调用方传任何显式参数 */
    sb.api.questionCardRestoreView(rebuilt.host, key, caret, sb.api.questionCardScrollSnapshot(rebuilt.host));

    assert.equal(rebuilt.els[1].focused, true, '焦点必须回到被点选的那个选项（键盘用户靠它继续 Tab/方向键导航）');
    assert.equal(rebuilt.els[0].focused, false, '不得串到兄弟选项：data-opt-index 不同则身份不同');
    assert.equal(rebuilt.els[1].selCalls.length, 0, '按钮不应调用 setSelectionRange');
});

test('行为：滚动恢复必须排在 focus() 之后，否则被 focus 的滚动副作用顶掉', () => {
    const sb = createFocusSandbox();
    /* 重建前：用户已把整卡滚到 120px、选项区滚到 80px（看到第 5 个长选项） */
    sb.makeEl('DIV', 'question-card', { as: 'card', scrollTop: 120, noCaret: true });
    sb.makeEl('DIV', 'question-card-options', { as: 'list', scrollTop: 80, noCaret: true });
    const opt = sb.makeEl('BUTTON', 'question-card-option', { data: { 'data-opt-index': '4' }, noCaret: true, focusResetsScroll: true });
    const host = sb.makeHost();
    sb.dom.activeElement = opt;

    const key = sb.api.questionCardFocusKeyIn(host);
    const scroll = sb.api.questionCardScrollSnapshot(host);
    assert.deepEqual(scroll, { card: 120, list: 80 }, '两个限高容器的滚动位置都必须快照');

    const rebuilt = sb.rebuild([
        { tag: 'DIV', cls: 'question-card', as: 'card', noCaret: true },
        { tag: 'DIV', cls: 'question-card-options', as: 'list', noCaret: true },
        { tag: 'BUTTON', cls: 'question-card-option selected', data: { 'data-opt-index': '4' }, noCaret: true, focusResetsScroll: true }
    ]);
    sb.api.questionCardRestoreView(rebuilt.host, key, null, scroll);

    /* 新 DOM 里的 card/list 需重新取（rebuild 已替换模块内引用） */
    const newCard = rebuilt.host.querySelector('.question-card');
    const newList = rebuilt.host.querySelector('.question-card-options');
    assert.equal(newCard.scrollTop, 120, '整卡滚动位置必须恢复；若恢复在 focus() 之前会被 focus 的滚入视口副作用重置为 0');
    assert.equal(newList.scrollTop, 80, '选项区滚动位置必须恢复（用户主动滚出的视野不能因重建丢失）');
    assert.equal(rebuilt.els[2].focused, true);
});

test('行为：光标越界必须夹紧', () => {
    const sb = createFocusSandbox();
    const input = sb.makeEl('INPUT', 'question-card-other-input', { value: '0123456789', selStart: 4, selEnd: 4 });
    const host = sb.makeHost();
    sb.dom.activeElement = input;
    const key = sb.api.questionCardFocusKeyIn(host);

    /* 重建后输入框内容变短（如收割后清空）：caret 4,4 已越界 */
    const rebuilt = sb.rebuild([{ tag: 'INPUT', cls: 'question-card-other-input', value: 'ab' }]);
    sb.api.questionCardRestoreView(rebuilt.host, key, { start: 4, end: 99 }, null);
    assert.deepEqual(rebuilt.els[0].selCalls, [[2, 2]], '光标必须夹在 value 长度内，越界会被浏览器静默丢弃或抛错');
});

test('行为：焦点不在卡内时不得乱聚焦（会话切换/他端作答场景）', () => {
    const sb = createFocusSandbox();
    sb.makeEl('INPUT', 'question-card-other-input', { value: 'x' });
    const host = sb.makeHost();
    /* 焦点在 body（用户正在看别处） */
    sb.dom.activeElement = sb.dom.body;
    assert.equal(sb.api.questionCardFocusKeyIn(host), '', '焦点在 body 时必须返回空 key');
    /* 焦点在卡外的元素（如主输入框）：contains 为假 */
    const outsider = { nodeType: 1, tagName: 'TEXTAREA', className: 'chat-input', attributes: [] };
    sb.dom.activeElement = outsider;
    assert.equal(sb.api.questionCardFocusKeyIn(host), '', '焦点在卡外时不得当成卡内焦点去恢复（否则会把用户从主输入框抢走）');
    assert.equal(sb.api.questionCardCaretIn(host), null);

    /* key 为空时 restore 必须一个都不聚焦 */
    const rebuilt = sb.rebuild([{ tag: 'INPUT', cls: 'question-card-other-input', value: 'x' }]);
    sb.api.questionCardRestoreView(rebuilt.host, '', null, null);
    assert.equal(rebuilt.els[0].focused, false, '无焦点现场时不得抢焦点（否则切回会话就被弹进输入框）');

    /* 防御：host 为空 / scroll 为空均不得抛错 */
    sb.api.questionCardRestoreView(null, 'X', { start: 0, end: 0 }, { card: 1, list: 1 });
});
