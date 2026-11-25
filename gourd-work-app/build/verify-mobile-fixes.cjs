'use strict';
/* ===== build/verify-mobile-fixes.cjs =====
 * gourd-work-app 的两处纯逻辑回归（uni-app x 组件无法在本机装载，
 * 故直接取源码中的真实实现执行，不用副本）：
 *
 *  1) 会话列表排序：sortInWorkspace 必须「置顶优先 + 时间倒序」。
 *     旧实现只比 pinned、其余 return 0，跨工作区 concat 后行序退化成
 *     「按 root 堆叠」，同一屏里"刚刚"和旧时间交错 —— 用户报障
 *     「消息加载有点杂乱无章」。
 *
 *  2) user 回显去重：内核广播 user 帧后，发送端必须按 clientMessageId
 *     精确跳过自己的气泡；他人的消息必须保留（PC 能看到手机发的话）。
 *
 * 运行：node build/verify-mobile-fixes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const SRC_PATH = path.join(__dirname, '..', 'hooks', 'useConversations.ts');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/** 从 TS 源码里截出某个函数/常量的完整定义（按大括号配平），不依赖行号。 */
function extractBlock(needle) {
    const start = SRC.indexOf(needle);
    if (start === -1) throw new Error('not found in useConversations.ts: ' + needle);
    let depth = 0;
    let seen = false;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') { depth++; seen = true; }
        else if (c === '}') {
            depth--;
            if (seen && depth === 0) return SRC.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces for: ' + needle);
}

/** 把 TS 函数体转成可执行的 JS：去掉类型注解、接口形态。 */
function loadSortInWorkspace() {
    const block = extractBlock('function sortInWorkspace(');
    const js = block
        // 参数/返回类型注解
        .replace(/\(\s*list:\s*Conversation\[\]\s*\)\s*:\s*Conversation\[\]/g, '(list)')
        .replace(/\(\s*a:\s*Conversation\s*,\s*b:\s*Conversation\s*\)\s*:\s*number/g, '(a, b)')
        .replace(/:\s*Conversation\[\]/g, '')
        .replace(/:\s*number/g, '')
        .replace(/:\s*boolean/g, '');
    // eslint-disable-next-line no-new-func
    return new Function(js + '; return sortInWorkspace;')();
}

const sortInWorkspace = loadSortInWorkspace();

/* ---------------- 1) 排序 ---------------- */

const NOW = 1_700_000_000_000;
const mk = (id, pinned, ageMs) => ({ id, pinned, updatedAt: NOW - ageMs });

// 复刻 refreshConversations 的拼接形态：全局区在前、各项目区在后，
// 每段内部各自已按时间倒序 —— 跨段就没有时间轴了。
const globalRows = [mk('g-old', false, 3 * 86400_000), mk('g-mid', false, 3600_000)];
const projRows = [mk('p-new', false, 60_000), mk('p-newer', false, 5_000)];
const concat = globalRows.concat(projRows);

const sorted = sortInWorkspace(concat);

assert.deepEqual(sorted.map((c) => c.id), ['p-newer', 'p-new', 'g-mid', 'g-old'],
    'non-pinned rows must be ordered by updatedAt desc across workspaces, not by concat order');

// 置顶始终在前，且置顶组内部同样按时间倒序
const withPins = [
    mk('a', false, 1_000),
    mk('pin-old', true, 90 * 86400_000),
    mk('b', false, 500),
    mk('pin-new', true, 5_000),
];
assert.deepEqual(sortInWorkspace(withPins).map((c) => c.id), ['pin-new', 'pin-old', 'b', 'a'],
    'pinned rows lead, and are themselves ordered by recency');

// 不能原地改入参（refreshConversations 会把结果直接赋给 conversations.value）
const input = [mk('x', false, 10), mk('y', false, 1)];
const snapshot = input.map((c) => c.id);
sortInWorkspace(input);
assert.deepEqual(input.map((c) => c.id), snapshot, 'sortInWorkspace must not mutate its input');

// 同毫秒时必须稳定（v-for 用 id 做 key，抖动会导致行闪动）
assert.deepEqual(sortInWorkspace([mk('b', false, 0), mk('a', false, 0)]).map((c) => c.id), ['a', 'b'],
    'equal timestamps fall back to id so the order is deterministic');

/* ---------------- 2) 回显身份去重 ---------------- */

// 必须在 user 分支里、且在文本兜底之前按 clientMessageId 比对
const consumeFrame = extractBlock('function consumeFrame(');
assert.ok(/pendingClientMsgId\.get\(sessionId\)/.test(consumeFrame),
    'consumeFrame must look up the pending client message id');
assert.ok(/clientMessageId/.test(consumeFrame),
    'consumeFrame must read clientMessageId off the frame');
assert.ok(/echoMsgId === ownMsgId/.test(consumeFrame),
    'consumeFrame must compare by identity, not by text');
// 顺序：身份判定要早于「尾部同文」兜底（否则同文连发会被误吞）
const idCheckAt = consumeFrame.indexOf('echoMsgId === ownMsgId');
const textFallbackAt = consumeFrame.indexOf('pendingUserEcho.get(sessionId)');
assert.ok(idCheckAt !== -1 && textFallbackAt !== -1 && idCheckAt < textFallbackAt,
    'identity dedupe must run before the tail-text fallback');

// sendMessage 必须真的把 id 发给内核，否则身份判定永远不成立
assert.ok(/clientMsgId/.test(SRC), 'sendMessage must generate a client message id');
const payloadLine = SRC.match(/const payload: ApiBody = \{[^}]*clientMessageId[^}]*\}/);
assert.ok(payloadLine != null, 'the /web/chat/input payload must carry clientMessageId');
assert.ok(/pendingClientMsgId\.set\(id, clientMsgId\)/.test(SRC),
    'the id must be registered so the echo can be matched');

// 失败/busy/设备切换都要清理，否则会误吞后续消息
const cleanupSites = (SRC.match(/pendingClientMsgId\.delete\(/g) || []).length;
assert.ok(cleanupSites >= 3, 'pendingClientMsgId must be cleared on fail, busy and device change (found ' + cleanupSites + ')');
assert.ok(/pendingClientMsgId\.clear\(\)/.test(SRC),
    'device change must clear the whole map');

/* ---------------- 3) 字号三档 ---------------- */

const rowStyle = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'app-conv-row', 'app-conv-row.uvue'), 'utf8');
const sizes = [...rowStyle.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => m[1]);
for (const s of sizes) {
    assert.ok(Number.isInteger(Number(s)), 'conversation rows must not use fractional font sizes (saw ' + s + 'px)');
}
assert.ok(sizes.includes('15') && sizes.includes('12'),
    'conversation rows use the 15/12 pair of the three-step scale');

const drawerStyle = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'app-conv-drawer', 'app-conv-drawer.uvue'), 'utf8');
for (const m of drawerStyle.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number.isInteger(Number(m[1])),
        'the conversation drawer must not use fractional font sizes (saw ' + m[1] + 'px)');
}
assert.ok(!/font-weight:\s*650/.test(rowStyle),
    'pinning must not be expressed as a heavier weight in the row (that is what made rows look uneven)');

/* ---------------- 4) 批次盖子：运行时耗时 / i18n / 点击语义 / 状态槽 ---------------- */

const bubblePath = path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue');
const bubble = fs.readFileSync(bubblePath, 'utf8');
const dataModel = fs.readFileSync(path.join(__dirname, '..', 'data', 'app-data.ts'), 'utf8');
const tools = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tools.ts'), 'utf8');
const localeDir = path.join(__dirname, '..', 'locale');
const langFiles = fs.readdirSync(localeDir).filter((f) => f.endsWith('.json'));

// 2) batchStartedAt 必须是活字段：数据模型透传到 ChatBlock，hook 写入 head，
//    组件每秒 tick 用 formatElapsed 展示运行中耗时（不再是「注释说有、其实没人读」）。
assert.ok(/startedAt:\s*number/.test(dataModel), 'ChatBlock must carry the live batch startedAt');
assert.ok(/head\.startedAt\s*=\s*state\.batchStartedAt/.test(SRC),
    'ensureProcessBatch must publish the batch start time onto the head block');
// PC 口径：运行中耗时走 formatBatchElapsed（<1s/Ns/Nmin Ns 整秒进位），跟排在盖子 label 内
assert.ok(/formatBatchElapsed\(item\.startedAt,\s*nowTick\.value\)/.test(bubble),
    'the running batch must render an elapsed label from its start time (PC formatBatchElapsed parity)');
assert.ok(/setInterval\(/.test(bubble) && /onUnmounted\(/.test(bubble) && /clearInterval\(/.test(bubble),
    'the elapsed ticker must be started and cleared with the component lifecycle');
assert.ok(!/state\.batchCount/.test(SRC), 'the dead batchCount counter must not survive on TurnState');
assert.ok(/export function formatElapsed\(/.test(tools), 'shared elapsed formatter must live in utils (no hooks<->components cycle)');

// 3-a) 计数文案不硬编码，12 语言全部接线。
// PC 对齐后：盖子收口 label 由 closeBatch 落「执行工具 N 次 · 思考 M 次」（chat.batch_done_count /
// chat.batch_thinking_count）。整轮摘要 2026-11 定稿：compactTurn 只落「状态+耗时」短头，
// 分类计数由 counts 驱动气泡层「图标+数字」chips（长文本拼接是窄屏折行遮挡真因，禁止回潮）。
// chat.turn.tools/reasons/agents/texts 键保留在语言包（chips 语义与历史口径），不再拼进 summary。
assert.ok(!/'\s*项'|\"\s*项\"|项'\)/.test(bubble), 'the bubble must not hard-code the Chinese item unit');
assert.ok(!/parts\.push\(t\('chat\.turn\./.test(SRC) && !/msg\.summary = parts\.join/.test(SRC),
    'compactTurn must not concatenate count phrases into summary (chips render counts; long text wraps and overlaps)');
assert.ok(/texts: state\.texts/.test(SRC), 'compactTurn must persist the texts count for the process-text chip');
assert.ok(/chat\.batch_done_count/.test(SRC) && /chat\.batch_thinking_count/.test(SRC),
    'closeBatch must label counts via chat.batch_done_count/thinking_count (PC parity)');
assert.equal(langFiles.length, 12, 'expected 12 locale packs');
for (const f of langFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
    assert.ok(typeof pack['chat.turn.tools'] === 'string' && /\{n\}/.test(pack['chat.turn.tools']),
        f + ' must define chat.turn.tools with the {n} placeholder');
    assert.ok(typeof pack['chat.batch_done_count'] === 'string' && /\{count\}/.test(pack['chat.batch_done_count']),
        f + ' must define chat.batch_done_count with the {count} placeholder');
}

// 3-b) 交互态与文案相符：无成员批次不绑折叠语义；body 常驻且不靠点击显隐；
//      （expanded 曾只控制 preview 消失，现已连字段一并删除——见下方 3-d）
// 分段渲染重构后 head 经 seg.head! 传入（旧模板是 item）：两种形态都合法，语义不变
assert.ok(/onToggleBatch\((?:item|seg\.head!)\)/.test(bubble) && /hasMember/.test(bubble),
    'batch header must guard the toggle against empty batches');
assert.ok(!/onToggleBlock/.test(bubble), 'row head must not claim a toggle it cannot deliver');
assert.ok(/v-if="item\.body\.length > 0"/.test(bubble) && !/item\.expanded && item\.body/.test(bubble),
    'process body stays visible; expanded must not gate it');
assert.ok(!/!item\.expanded/.test(bubble), 'row preview must not disappear on an invisible expanded flip');

// 3-c) 死类清理：__row--failed 无样式定义，不应再挂在模板上
assert.ok(!/__row--failed/.test(bubble), 'the undefined __row--failed modifier must be gone');

// 3-d) 死字段清理：ChatBlock.expanded 在模板中已无任何读取方（body/preview 常驻后），
//      类型定义与 hooks 里的死写入必须一并删除，不留「看起来还能折叠」的误导。
assert.ok(!/expanded:\s*boolean/.test(dataModel),
    'ChatBlock must not carry the unread expanded flag (no consumer since body stays visible)');
assert.ok(!/item\.expanded|block\.expanded/.test(SRC),
    'hooks must not keep dead expanded writes that no template ever reads');

console.log('PASS  batch: live elapsed ticker, shared formatter, no dead counter');
console.log('PASS  i18n: chat.turn.items + batch_done_count wired across 12 packs, no hard-coded unit');
console.log('PASS  interaction: empty batch guarded, body always visible, dead row modifier removed');
console.log('PASS  cleanup: unread ChatBlock.expanded field fully removed (type + dead writes)');

// ===== 4) 交互卡（ask 问答 / HITL 审批）：手机必须能作答，不能退回只读镜像 =====
// 背景：旧实现把 question/hitl 帧一律落成「等待在桌面客户端处理」的一次性提示行——
// 手机能看见挂起却点不了任何按钮。以下断言锁死「可作答」链路的四个关键环节。
const card = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-interact-card', 'app-interact-card.uvue'), 'utf8');
const chat = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat', 'app-chat.uvue'), 'utf8');
const bubbleSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue'), 'utf8');

// 4-a) 数据模型：交互字段齐备（缺一个 UI 就渲染不出可操作形态）
for (const field of ['interact', 'questions', 'answers', 'submitting', 'submitError', 'command', 'resolvedText']) {
    assert.ok(new RegExp(field + '\\s*:').test(dataModel), 'ChatBlock must carry ' + field);
}

// 4-b) 帧解析：question/hitl 建可作答卡，闭环帧回填答案（不再只落一行 notice）
assert.ok(/block\.interact = 'hitl'/.test(SRC) && /block\.interact = 'question'/.test(SRC),
    'question/hitl frames must build operable cards, not read-only notices');
assert.ok(/parseAskQuestions\(/.test(SRC), 'question frame args must be parsed into questions');
assert.ok(/resolvedAnswersText\(/.test(SRC) && /item\.interact = 'resolved'/.test(SRC),
    'answered frames must close the card and echo the answer text');

// 4-c) 提交链路：三项方法 + 字段名必须与内核 InputFields 完全一致
assert.ok(/questionAnswer: buildAskAnswersPayload\(block\)/.test(SRC),
    'answer submit must send questionAnswer (kernel InputFields wire name)');
assert.ok(/hitlAction: approved \? 'approve' : 'reject'/.test(SRC),
    'approval submit must send hitlAction approve/reject');
assert.ok(/payload\['actionId'\] = actionId/.test(SRC),
    'actionId must ride along so the kernel can match the exact pending card');
assert.ok(/function buildAskAnswersPayload/.test(SRC) && /skipped: !answered/.test(SRC),
    'unanswered questions must be submitted as skipped (keeps index alignment)');

// 4-d) 失败回退：提交失败必须解禁卡片，否则任务永不恢复
assert.ok(/function failInteract/.test(SRC) && /block\.submitting = false/.test(SRC) &&
    /block\.submitError = /.test(SRC), 'a failed submit must re-enable the card and keep user input');

// 4-e) 挂起卡兜底：帧窗口翻过去后靠 pendingQuestion 探针补卡
assert.ok(/probePendingQuestion/.test(SRC) && /\/web\/chat\/pendingQuestion/.test(SRC),
    'a pendingQuestion probe must backfill cards the frame replay window missed');
assert.ok(/await probePendingQuestion\(id\)/.test(SRC),
    'the probe must run when a conversation is opened');

// 4-f) UI 接线：交互卡分支必须在通用过程行之前，且事件一路透传到 hook
assert.ok(/app-interact-card/.test(bubbleSrc) && /item\.interact\.length > 0/.test(bubbleSrc),
    'bubble must render the interact card for blocks carrying interact role');
assert.ok(bubbleSrc.indexOf('app-interact-card') < bubbleSrc.indexOf('app-chat-bubble__row-head'),
    'the interact card branch must precede the generic process row (else the card never renders)');
assert.ok(/@approve="onInteractApprove"/.test(chat) && /@answer="onInteractAnswer"/.test(chat) &&
    /@edit="onInteractEdit"/.test(chat), 'app-chat must forward card events to the hook');
assert.ok(/approveHitl, answerQuestion, setQuestionAnswer/.test(chat),
    'app-chat must destructure the three submit methods from useConversations');
// resolved 卡是 v-else 兜底分支（不用 interact === 'resolved' 判定），
// 因此按「三态渲染齐全」断言：question / hitl 显式分支 + resolvedText 回显出口
assert.ok(/v-if="interact === 'question'"/.test(card) && /v-else-if="interact === 'hitl'"/.test(card),
    'the card must branch on question and hitl roles');
assert.ok(/resolvedText/.test(card) && /chat\.interact\.resolved/.test(card),
    'the card must echo the answer text in its closed (resolved) role');

// 4-g) 12 语言词条齐备（缺词条界面会直接显示原始 key）
for (const f of langFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
    for (const k of ['chat.interact.hitlTitle', 'chat.interact.askTitle', 'chat.interact.approve',
        'chat.interact.reject', 'chat.interact.submit', 'chat.interact.submitFailed']) {
        assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
    }
}
// 4-h) 审批必须本地闭环，不能等 hitl_released。
//      内核 handle_hitl_action（mod.rs:2521-2577）只 resume、不广播；
//      core 里 hitl_released 只有 mod.rs:1568 一个发送点（切到 full access）。
//      等帧 = 卡片永远停在「提交中」，挂起任务在手机上再也点不动。
assert.ok(/function resolveInteract/.test(SRC) && /block\.interact = 'resolved'/.test(SRC),
    'a successful submit must close the card locally');
assert.ok(/resolveInteract\(id, block, t\(approved \?/.test(SRC),
    'approval must close locally instead of waiting for a hitl_released frame the kernel never sends');
assert.ok(/resolveInteract\(id, block, echo\)/.test(SRC),
    'question answers must close locally too (frame only overwrites with the authoritative text later)');
assert.ok(/\}, \(\): void => \{\n\s*resolveInteract/.test(SRC) || /onOk != null\) onOk\(\)/.test(SRC),
    'submitInteract must accept and invoke a success callback');

console.log('PASS  interact: ask/approval cards are operable on mobile (parse, submit, fail-recovery, probe)');

// ===== 5) 二轮评审修复：续跑运行态 / 挂起文案 / 僵尸卡 / 全量词条 =====
// 5-a) resolveInteract 绝不能清 running：内核提交后立即 spawn_resume（同 runId），
//      清掉会让恢复段开头帧被「非运行态」守卫丢弃、或并进已折叠旧轮（答完回答消失）。
// 注释里就写着 running.delete（解释为什么不能清），断言前剥掉注释只查真实代码
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const resolveFn = stripComments(extractBlock('function resolveInteract('));
assert.ok(!/running\.delete/.test(resolveFn),
    'resolveInteract must NOT clear running: the kernel resumes immediately after a successful submit');
assert.ok(/appendStreamingPlaceholder\(conv\)/.test(resolveFn),
    'resolveInteract must reopen a streaming tail when the suspended done already closed it');
// submitInteract 不清 runId（spawn_resume 沿用原 runId，清掉会停不掉续跑）
const submitFn = stripComments(extractBlock('function submitInteract('));
assert.ok(!/cursor\.runId = ''/.test(submitFn),
    'submitInteract must keep the runId so an immediate Stop can interrupt the resumed run');

// 5-b) 挂起 done 不再写「等待在桌面客户端处理」（手机已可作答，文案必须与能力一致）
assert.ok(!/t\('chat\.pendingDesktop'\)/.test(SRC),
    'the suspended-done meta must not claim the task can only be handled on desktop');
assert.ok(/chat\.interact\.pendingMeta/.test(SRC) && /chat\.turn\.suspended/.test(SRC),
    'suspended done must point at the local card (or fall back to a neutral suspended word)');

// 5-c) 权威 null 收僵尸卡：他端已答/挂起过期后，本地未提交问答卡必须闭环
assert.ok(/function closeZombieQuestions/.test(SRC),
    'a null pendingQuestion probe must close stale local question cards');
const probeFn = stripComments(extractBlock('async function probePendingQuestion('));
assert.ok(/closeZombieQuestions\(current\)/.test(probeFn),
    'the probe must invoke zombie cleanup on authoritative null');
assert.ok(!/if \(running\.has\(id\)\) return/.test(probeFn),
    'the probe must not short-circuit on running (suspension keeps running=true; that would kill the main backfill path)');

// 5-d) 全量词条：hooks/组件引用的每个 chat.*/model.*/common.* key 必须 12 语言齐备。
//      上一轮只补了 chat.turn.items，chat.turn.running/done/tools… 23 个 key 仍缺失，
//      批次盖子与整轮摘要在真机上直接显示原始 key 文本。
const keyRe = /'((?:chat|model|common)\.[a-zA-Z0-9.]+)'/g;
const usedKeys = new Set();
for (const src of [SRC, bubble, card, chat,
    fs.readFileSync(path.join(__dirname, '..', 'components', 'app-model-sheet', 'app-model-sheet.uvue'), 'utf8')]) {
    let m;
    while ((m = keyRe.exec(src))) usedKeys.add(m[1]);
}
for (const f of langFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
    for (const k of usedKeys) {
        assert.ok(typeof pack[k] === 'string' && pack[k].length > 0,
            f + ' missing locale key referenced by code: ' + k);
    }
}
console.log('PASS  round2: resume keeps running, suspended copy honest, zombie cards closed, all ' + usedKeys.size + ' referenced keys exist in 12 packs');

// ===== 6) 输入框多行：textarea 自动换行 + 收起态草稿多行预览 =====
const composer = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-composer', 'app-composer.uvue'), 'utf8');
assert.ok(/<textarea v-if="expanded"/.test(composer),
    'the expanded composer must be a multi-line textarea, not a single-line input');
assert.ok(/:auto-height="true"/.test(composer),
    'the composer textarea must grow with content (auto-height)');
assert.ok(/max-height:\s*132px/.test(composer),
    'the growing textarea must be capped so it cannot swallow the whole screen');
// 官方已废弃 UCSS lines：本项目是蒸汽模式（vapor），:lines 属性与 lines: 样式编译告警且不生效，
// 必须用 text 的 max-lines 组件属性（VDOM 写法回潮即真机截断静默失效）
assert.ok(/:max-lines="hasText && !voiceMode \? 3 : 1"/.test(composer),
    'the collapsed draft preview must allow up to 3 lines via the vapor text max-lines component prop');
assert.ok(!/:lines="/.test(composer) && !/^\s*lines:\s*\d/m.test(composer),
    'deprecated UCSS lines must not regress (vapor compile warning + silently ignored truncation)');
assert.ok(/#ifndef APP[\s\S]*?-webkit-line-clamp:\s*3[\s\S]*?#endif/.test(composer),
    'the H5 draft preview needs a line-clamp fallback guarded by #ifndef APP');
assert.ok(/__box--draft/.test(composer) && /__center--draft/.test(composer),
    'the collapsed bar must grow with a multi-line draft (box + center draft variants)');
console.log('PASS  composer: multi-line textarea with auto-height, capped growth, 3-line collapsed draft preview');

/* ---------------- 7) 本轮 codereview 修复回归 ---------------- */

// 7-a) 空文本 user 帧（PC 纯附件消息）不能整帧丢弃：必须先按 imagePaths/filePaths
//      组装占位文案再判空，且渲染/去重/覆盖全部用 displayText 而不是原始 text。
const userBranchAt = consumeFrame.indexOf("if (kind === 'user' || kind === 'user_input')");
assert.ok(userBranchAt !== -1, 'user branch must exist');
const userBranch = consumeFrame.slice(userBranchAt, consumeFrame.indexOf('// 过程块到来前先建运行批次盖子'));
assert.ok(/imagePaths/.test(userBranch) && /filePaths/.test(userBranch),
    'the user branch must read attachment paths for empty-text frames');
assert.ok(/const displayText/.test(userBranch) && /if \(displayText\.length === 0\) return/.test(userBranch),
    'the empty guard must run on displayText (attachment placeholder), not the raw text');
assert.ok(/emptyChatMessage\(nextMsgId\(\), 'user', displayText/.test(userBranch),
    'the rendered user row must use displayText');
assert.ok(!/row\.text = text\b/.test(userBranch),
    'echo overwrite must not write the raw (possibly empty) kernel text');
for (const f of langFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
    for (const k of ['chat.attachmentImages', 'chat.attachmentFiles']) {
        assert.ok(typeof pack[k] === 'string' && /\{n\}/.test(pack[k]),
            f + ' must define ' + k + ' with the {n} placeholder');
    }
}

// 7-b) 身份回显覆盖必须先取登记再销账（旧实现先 delete 再 get，永远 undefined）
const getAt = userBranch.indexOf('const sentText: string | undefined = pendingUserEcho.get(sessionId)');
const delAt = userBranch.indexOf('pendingUserEcho.delete(sessionId)');
assert.ok(getAt !== -1 && delAt !== -1 && getAt < delAt,
    'the echo overwrite must read the registered text before deleting the registration');

// 7-c) 轮收口销账：done / error / markStopped 都必须清残留登记，
//      否则 echo 丢失后下一条他端 user 帧会被当成自己的回显吞掉。
assert.ok(/function clearPendingEcho\(/.test(SRC), 'a shared clearPendingEcho helper must exist');
const doneBranch = consumeFrame.slice(consumeFrame.indexOf("if (kind === 'done')"), consumeFrame.indexOf("if (kind === 'error')"));
assert.ok(/clearPendingEcho\(sessionId\)/.test(doneBranch), 'done must settle the pending echo registration');
const errBranch = consumeFrame.slice(consumeFrame.indexOf("if (kind === 'error')"));
assert.ok(/clearPendingEcho\(sessionId\)/.test(errBranch), 'error must settle the pending echo registration');
const stopFn = extractBlock('function markStopped(');
assert.ok(/clearPendingEcho\(id\)/.test(stopFn), 'manual stop must settle the pending echo registration');

// 7-d) uvue 的 class 属性不支持 {{ }} 文本插值：动态修饰类必须走 :class 绑定。
//      app-interact-card 曾用 class="...--{{ interact }}"，hitl 警示边框/resolved
//      浅底在真机上永不生效。
assert.ok(!/class="[^"]*\{\{/.test(card),
    'interact card must not interpolate inside a plain class attribute (uvue does not support it)');
assert.ok(/:class="'app-interact-card--' \+ interact"/.test(card),
    'the interact modifier class must be bound via :class');
console.log('PASS  round3: empty-text attachment frames render, echo overwrite reads before delete, turn settle clears registrations, uvue class binding fixed');

/* ---------------- 8) 侧栏浮层化 + 工作空间选择迁移 + 键盘局部抬升 ---------------- */
// 背景：旧窄屏侧栏是 swiper 整屏分页（占满全屏、误导用户），工作空间在抽屉里当选择器，
// 输入框 adjust-position=true 由系统整页顶起（hero/头部全被推出屏）。本轮对齐 workbuddy：
// 浮层抽屉（遮罩+滑入动画+任意位置右滑）、分组/工作区箭头折叠、选择移到新对话输入区、
// 键盘只抬输入区。

const homeSrc = fs.readFileSync(path.join(__dirname, '..', 'pages', 'home', 'index.uvue'), 'utf8');
const drawerSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-conv-drawer', 'app-conv-drawer.uvue'), 'utf8');
const wsSheetSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-ws-sheet', 'app-ws-sheet.uvue'), 'utf8');
const viewportSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useViewport.ts'), 'utf8');
const runEnvSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useRunEnv.ts'), 'utf8');
const workspacesSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useWorkspaces.ts'), 'utf8');

// 8-a) 窄屏不再整屏分页：swiper 与分页索引必须整体移除
assert.ok(!/<swiper/.test(homeSrc) && !/swiperIndex/.test(homeSrc),
	'home must not keep the full-screen swiper paging (it made the drawer cover the whole screen)');

// 8-b) 浮层抽屉：fixed 遮罩+面板、双态类名驱动滑入动画、右侧留缝宽度
assert.ok(/home__drawer-mask/.test(homeSrc) && /position: fixed/.test(homeSrc),
	'the drawer mask/panel must be fixed overlays above the main pane');
assert.ok(/translateX\(-106%\)/.test(homeSrc) && /home__drawer--on/.test(homeSrc),
	'the drawer must slide in from the left via a two-state transform transition');
assert.ok(/drawerWidth/.test(viewportSrc) && /DRAWER_WIDTH_RATIO = 0\.86/.test(viewportSrc),
	'the drawer keeps a right gap (86% viewport width) so the main page stays visible');

// 8-c) 手势：全屏任意位置右滑开抽屉；抽屉左滑关闭；返回键先收抽屉
assert.ok(/onTouchMove/.test(homeSrc) && /SWIPE_OPEN_DX/.test(homeSrc) && /gestureFired/.test(homeSrc),
	'a right-swipe anywhere must open the drawer (one fire per gesture, vertical scroll untouched)');
assert.ok(/onDrawerTouchMove/.test(homeSrc), 'swiping left on the drawer must close it');
assert.ok(/onBackPress/.test(homeSrc) && /closeDrawer\(\)/.test(homeSrc),
	'the back key must close the drawer before anything else');

// 8-d) 抽屉交互对齐 workbuddy：分组/工作区箭头折叠 + 展开动画；整行不再是选择器
assert.ok(/onTasksToggle/.test(drawerSrc) && /onSpacesToggle/.test(drawerSrc) && /toggleWs\(ws\.root\)/.test(drawerSrc),
	'group headers and workspace rows must toggle collapse/expand');
assert.ok(/app-drawer__group-arrow--closed/.test(drawerSrc) && /app-drawer__ws-icon--open/.test(drawerSrc),
	'arrows must rotate with the collapse state');
assert.ok(/app-drawer__sect--on/.test(drawerSrc) && /app-drawer__ws-sub--on/.test(drawerSrc),
	'expanded sections must animate in (opacity+translateY two-state)');
assert.ok(!/app-drawer__ws-row--on/.test(drawerSrc) && !/spaces\.setCurrent/.test(drawerSrc),
	'workspace rows must no longer act as a selector (no selected highlight / check)');
assert.ok(/@click\.stop="onNewInWorkspace\(ws\.root\)"/.test(drawerSrc),
	'the workspace + must stay a per-space new-chat entry');

// 8-e) 工作空间选择迁移到新对话侧：composer chip → ws sheet → env.setWorkspace；
//      新建对话默认「对话」，侧栏＋默认对应空间
assert.ok(/showWs/.test(composer) && /emit\('open-ws'\)/.test(composer),
	'the welcome composer must carry a workspace chip');
assert.ok(/app-ws-sheet/.test(homeSrc) && /openSheet\('ws'\)/.test(homeSrc) && /@select="onPickWorkspace"/.test(homeSrc),
	'home must host the workspace picker sheet wired to the chip');
assert.ok(/DEFAULT_WORKSPACE/.test(wsSheetSrc) && /home\.ws\.chatHint/.test(wsSheetSrc),
	'the picker must offer the no-workspace chat row first');
assert.ok(/beginNewSession\(true\)/.test(homeSrc) && /resetWorkspace/.test(runEnvSrc),
	'new chat must reset the workspace to the global chat area (unselected = chat)');
assert.ok(/env\.setWorkspace\(root\)/.test(homeSrc) && /@new-in-ws="onNewInWorkspace"/.test(homeSrc),
	'the sidebar + must default the new chat to that workspace');
assert.ok(!/lastWorkspace/.test(workspacesSrc),
	'the old persistent workspace-selection memory must be gone (selection now lives in the new-chat side)');

// 8-f) 键盘局部抬升：adjust-position=false + keyboardheightchange 占位 + 清零兜底
assert.ok(/:adjust-position="false"/.test(composer) && !/:adjust-position="true"/.test(composer),
	'the composer must stop letting the system push the whole page up');
assert.ok(/@keyboardheightchange="onKeyboardHeight"/.test(composer) && /__kbd/.test(composer),
	'keyboard height must lift only the composer via an equal-height spacer');
assert.ok(/@blur="onBlur"/.test(composer) && /keyboardHeight\.value = 0/.test(composer),
	'the spacer must be cleared on blur/collapse/unmount so it never strands the input mid-screen');

// 8-h) 评审修复：抽屉定时器卸载清理、内嵌弹层返回键优先、入场动画独立 timer
assert.ok(/onUnmounted/.test(homeSrc) && /clearTimeout\(drawerOpenTimer\)/.test(homeSrc) && /clearTimeout\(drawerCloseTimer\)/.test(homeSrc),
	'home must clear the drawer timers on unmount (reLaunch must not leave dangling callbacks)');
assert.ok(/defineExpose\(\{ handleBack \}\)/.test(drawerSrc) && /inst\.handleBack\(\)/.test(homeSrc),
	'the back key must let drawer-internal sheets consume the event before closing the drawer');
assert.ok(/let tasksTimer/.test(drawerSrc) && /let spacesTimer/.test(drawerSrc) && /let subTimer/.test(drawerSrc) && !/let readyTimer/.test(drawerSrc),
	'each entrance animation needs its own timer (a shared one strands a section at opacity:0)');

// 8-g) 新词条 12 语言齐备
for (const f of langFiles) {
	const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
	for (const k of ['home.ws.chatHint', 'home.ws.empty']) {
		assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
	}
}
console.log('PASS  drawer: overlay slide-in + swipe gestures, workbuddy-style collapsible groups, workspace picker moved to new-chat, keyboard lifts only the composer');

/* ---------------- 9) 语音「未授权」根治：manifest 权限层级 + 拒绝引导去设置 ---------------- */
// 真因（APK 反编译实锤）：RECORD_AUDIO 曾配在 manifest.json 的 app-android.permissions
// 顶层——官方 schema 是 app-android.distribute.permissions，云打包静默丢弃错层配置，
// APK 里根本没有 RECORD_AUDIO：系统对未声明权限直接拒绝且不弹授权框，
// 用户从安装到使用从未见过授权弹窗，每次按住说话都 toast「无法访问麦克风」。

// 9-a) manifest.json：权限必须在 distribute 下（JSONC 去注释后解析验证）
const manifestRaw = fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8');
const manifestJson = JSON.parse(manifestRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
const androidNode = manifestJson['app-android'];
assert.ok(androidNode && androidNode.distribute && Array.isArray(androidNode.distribute.permissions)
	&& androidNode.distribute.permissions.includes('android.permission.RECORD_AUDIO'),
	'RECORD_AUDIO must live under app-android.distribute.permissions (top-level app-android.permissions is silently dropped by cloud packaging)');
assert.ok(!Array.isArray(androidNode.permissions),
	'the mis-placed top-level app-android.permissions array must be gone');

// 9-b) 插件 AndroidManifest 兜底自带 uses-permission（manifest merge，不依赖宿主配置正确）
const pluginManifest = fs.readFileSync(path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-android', 'AndroidManifest.xml'), 'utf8');
assert.ok(/<uses-permission android:name="android\.permission\.RECORD_AUDIO"\s*\/>/.test(pluginManifest),
	'the plugin manifest must declare RECORD_AUDIO itself so a host misconfiguration can never strip it again');
assert.ok(/android\.speech\.RecognitionService/.test(pluginManifest),
	'the Android 11+ <queries> visibility declaration must stay');

// 9-c) 已授权直录：不再每次按住都走 requestSystemPermission 框架链（个别 ROM 闪系统 UI 打断手势）
const speechAndroid = fs.readFileSync(path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-android', 'index.uts'), 'utf8');
assert.ok(/checkSystemPermissionGranted/.test(speechAndroid),
	'granted permission must short-circuit straight into the engine (no framework permission round-trip per hold)');
assert.ok(/doNotAskAgain/.test(speechAndroid) && /gotoSystemPermissionActivity/.test(speechAndroid),
	'Android must surface doNotAskAgain and expose the settings jump');

// 9-d) 三端接线：iOS/鸿蒙也导出 openPermissionSettings；接入层透出 permissionBlocked
const speechIos = fs.readFileSync(path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-ios', 'index.uts'), 'utf8');
const speechHarmony = fs.readFileSync(path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-harmony', 'index.uts'), 'utf8');
const speechSwift = fs.readFileSync(path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-ios', 'GworkSpeechEngine.swift'), 'utf8');
const recognizer = fs.readFileSync(path.join(__dirname, '..', 'utils', 'speech-recognizer.uts'), 'utf8');
assert.ok(/export function openPermissionSettings/.test(speechIos) && /openSettingsURLString/.test(speechSwift),
	'iOS must jump to the app settings page (denied-once permissions never re-prompt)');
assert.ok(/export function openPermissionSettings/.test(speechHarmony) && /application_info_entry/.test(speechHarmony),
	'HarmonyOS must jump to the app info page in system settings');
assert.ok(/permissionBlocked/.test(recognizer) && /openSpeechPermissionSettings/.test(recognizer),
	'the recognizer layer must surface permissionBlocked and the settings jump to the host');
assert.ok(/showSpeechError/.test(composer) && /home\.voice\.permSettings/.test(composer),
	'the composer must show a go-to-settings dialog instead of a dead-end toast on permanently denied permission');

// 9-e) 权限引导词条 12 语言齐备（GWork 品牌词由 verify-i18n 另行校验）
for (const f of langFiles) {
	const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
	for (const k of ['home.voice.permTitle', 'home.voice.permContent', 'home.voice.permSettings', 'home.voice.permCancel', 'home.voice.permDenied']) {
		assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
	}
}
console.log('PASS  voice: RECORD_AUDIO at the correct manifest level + plugin-side declaration, granted fast-path, denied-once guidance jumps to system settings (3 platforms), 12-lang keys');

/* ---------------- 10) 本轮全量 codereview 修复回归 ---------------- */

const chatSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat', 'app-chat.uvue'), 'utf8');

// 10-a) S-1 聊天态返回键：app-chat 暴露 handleBack（重命名>菜单>产物>加号>模型>运行环境），
//       home 返回链在 inChat 分支先经 chatRef 消化，宽窄屏都接线
assert.ok(/defineExpose\(\{ handleBack \}\)/.test(chatSrc),
	'app-chat must expose handleBack for the back-key chain (embedded sheets would otherwise become orphans above the drawer)');
const chatBack = chatSrc.slice(chatSrc.indexOf('function handleBack('));
const order = ['renameVisible', 'menuVisible', 'artifactSheetVisible', 'plusSheetVisible', 'modelSheetVisible', 'runSheetVisible']
	.map((k) => chatBack.indexOf(k));
assert.ok(order.every((v, i) => v !== -1 && (i === 0 || v > order[i - 1])),
	'chat handleBack must consume sheets top-most first: rename > menu > artifact > plus > model > run');
assert.ok((homeSrc.match(/<app-chat ref="chatRef"/g) || []).length === 2,
	'both wide and narrow app-chat instances must be wired to chatRef');
assert.ok(/chat\.handleBack\(\)/.test(homeSrc),
	'home onBackPress must let chat sheets consume the back key before opening the drawer');

// 10-b) M-1 键盘迟到帧：非聚焦态只接受 0 帧，blur/收起/卸载复位聚焦标志
assert.ok(/let inputFocused/.test(composer) && /if \(!inputFocused && e\.detail\.height > 0\) return/.test(composer),
	'late non-zero keyboardheightchange frames after blur must not re-raise the spacer');

// 10-c) M-2 欢迎态换工作空间即重拉模型清单（不等发送建会话才校正）
const runEnv = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useRunEnv.ts'), 'utf8');
const setWsFn = runEnv.slice(runEnv.indexOf('function setWorkspace('), runEnv.indexOf('function applyWorkspace('));
assert.ok(/refreshModels\(true\)/.test(setWsFn) && /boundSession\.value\.length === 0/.test(setWsFn),
	'picking a workspace in the welcome state must refresh the model list for the new root immediately');

// 10-d) M-3 子列表收起撤销在途 timer + subReady 初始 true（无挂载子列表时恒 true 不变式）
assert.ok(/const subReady: Ref<boolean> = ref<boolean>\(true\)/.test(drawerSrc),
	'subReady must start true (invariant: no mounted sub-list => flag true)');
const toggleFn = drawerSrc.slice(drawerSrc.indexOf('function toggleWs('), drawerSrc.indexOf('function handleBack('));
assert.ok(/clearTimeout\(subTimer\)/.test(toggleFn) && /subReady\.value = true/.test(toggleFn),
	'collapsing a workspace row must cancel the pending entrance timer and reset subReady');

// 10-e) M-4 关闭动画期遮罩不再拦截点击（尺寸归零），重开复位 closing
assert.ok(/drawerClosing/.test(homeSrc) && /home__drawer-mask--off/.test(homeSrc),
	'the mask must stop intercepting taps during the drawer close animation');
const openFn = homeSrc.slice(homeSrc.indexOf('function openDrawer('), homeSrc.indexOf('function closeDrawer('));
assert.ok(/drawerClosing\.value = false/.test(openFn),
	'reopening during the close animation must clear the closing flag');

// 10-f) L-7 二次补滚 timer 持句柄 + 卸载清理
assert.ok(/let scrollFixTimer/.test(chatSrc) && /clearTimeout\(scrollFixTimer\)/.test(chatSrc) && /onUnmounted/.test(chatSrc),
	'the 60ms scroll-fix timer must be held and cleared (per-frame streaming timers must not leak)');

// 10-g) L-1 展示值只读：RunEnv 展示字段不再 as Ref 双重断言
assert.ok(!/as Ref<string>/.test(runEnv) && !/as Ref<boolean>/.test(runEnv),
	'read-only display fields must be ComputedRef, not writable-Ref double assertions');
console.log('PASS  review-fixes: chat back-key chain, late keyboard frames, workspace model refresh, sub-list timer invariant, close-animation tap pass-through, scroll timer hygiene, readonly display refs');

/* ---------------- 11) iOS/鸿蒙语音核查修复：与安卓同级别的「从未弹授权/永远识别不出」根因 ---------------- */
// iOS 真因（官方 uts-for-ios §3.1）：云打包只合并插件 utssdk/app-ios/Info.plist，
// 项目根 Info.plist 是无效路径——隐私描述被静默忽略，iOS 缺 NSMicrophoneUsageDescription
// 会在 requestRecordPermission 处直接杀进程（比安卓更糟：闪退而非拒绝）。
// 鸿蒙真因（华为录音全链路方案）：writeAudio 单次仅接受 640/1280 字节，
// readData 回调块长不定，任意长度直喂会被引擎拒收——权限全对也永远识别不出字。

// 11-a) iOS 隐私描述必须在插件 app-ios/Info.plist（唯一合并路径），项目根不得再有同名文件
const iosPlistPath = path.join(__dirname, '..', 'uni_modules', 'gwork-speech', 'utssdk', 'app-ios', 'Info.plist');
assert.ok(fs.existsSync(iosPlistPath), 'the plugin app-ios/Info.plist must exist (cloud packaging merges only this path)');
const iosPlist = fs.readFileSync(iosPlistPath, 'utf8');
assert.ok(/NSMicrophoneUsageDescription/.test(iosPlist) && /NSSpeechRecognitionUsageDescription/.test(iosPlist),
	'both usage descriptions must be declared (missing mic description = crash at requestRecordPermission)');
assert.ok(!fs.existsSync(path.join(__dirname, '..', 'Info.plist')),
	'the root-level Info.plist must be gone (not an official read path; keeping it invites regression)');

// 11-b) iOS 已授权快路径 + doNotAskAgain 结构化派发（接入层不再按平台硬编码）
assert.ok(/SFSpeechRecognizer\.authorizationStatus\(\) == \.authorized/.test(speechSwift)
	&& /recordPermission == \.granted/.test(speechSwift),
	'granted permissions must short-circuit straight into beginSession (parity with the Android fast path)');
assert.ok(/doNotAskAgain/.test(speechIos) && /detail\.indexOf\('doNotAskAgain'\)/.test(speechIos),
	'the iOS entry must parse the Swift detail marker into the structured doNotAskAgain field');
assert.ok(!/#ifdef APP-IOS[\s\S]{0,200}blocked = true/.test(recognizer),
	'the recognizer must not hardcode iOS blocked=true anymore (the plugin now reports it)');

// 11-c) 鸿蒙 writeAudio 定长切块：640 字节缓冲 + 收尾补静音 + 终态清缓冲
assert.ok(/PCM_CHUNK_BYTES = 640/.test(speechHarmony) && /function feedPcm/.test(speechHarmony),
	'PCM must be chunked to the 640-byte writeAudio contract (arbitrary-length writes are rejected)');
assert.ok(/feedPcm\(new Uint8Array\(buffer\)\)/.test(speechHarmony)
	&& !/writeAudio\(sessionId, new Uint8Array\(buffer\)\)/.test(speechHarmony),
	'readData must feed through the chunker, never writeAudio the raw callback buffer');
assert.ok(/pad\.set\(pendingPcm, 0\)/.test(speechHarmony) && /resetPcm\(\)/.test(speechHarmony),
	'the tail must be silence-padded on stop and the pending buffer reset on every terminal state');
assert.ok(/1002200009/.test(speechHarmony),
	'the 5.1.0(18)+ internal-service error must be transient (retryable), not device-unsupported');
console.log('PASS  ios/harmony voice: plugin-level Info.plist (crash fix), granted fast-path + structured doNotAskAgain, 640-byte writeAudio chunking with tail flush');

/* ---------------- 12) 消息展示对齐 PC：文件变更卡 / 假附件删除 / markdown 正文 / 包体瘦身 ---------------- */
// 背景（用户四连报障）：
// a) 每条消息尾部 dump「文件变更 status=OK sessionId=… files=[{…}]」协议原文；
// b) 输入区上方常驻「照片·视频」假附件 tag（点了只写个名字，没有选图/上传链路）；
// c) AI 正文全是 markdown 原文（**加粗**、### 标题直接裸奔）；
// d) APK 20+MB：uni_modules 里躺着 uni-highlight(11.7MB)/uni-cmark(5.8MB)/uni-ai-x 全家桶没人引用。

// 12-a) 文件变更帧：不走通用 notice dump，走 applyFileChanges 紧凑卡
assert.ok(!/kind === 'file_changes' \|\|/.test(SRC) && !/\|\| kind === 'file_changes'/.test(SRC),
	'file_changes must be removed from the generic notice-kind chain (that chain dumps the raw manifest)');
assert.ok(/if \(kind === 'file_changes'\) \{\s*applyFileChanges\(conv, frame\)/.test(SRC),
	'file_changes frames must route to applyFileChanges');
assert.ok(/'changes:' \+ \(runId\.length > 0 \? runId : 'latest'\)/.test(SRC),
	'the changes card must be keyed per run so later revisions replace instead of stacking');
assert.ok(/chat\.changes\.edited/.test(SRC) && /block\.args = 'fileChanges'/.test(SRC),
	'the card must carry the edited-N-files label and the fileChanges marker');
// 空 files（possiblyIncomplete 警示快照）不落卡——桌面同款「不展示任何提示」
const applyFn = stripComments(extractBlock('function applyFileChanges('));
assert.ok(/if \(changes\.length === 0\)/.test(applyFn) && /splice\(idx, 1\)/.test(applyFn),
	'empty-files snapshots must not create a card and must retract an existing one');

// 12-b) parseFileChanges 纯函数执行：字段判型 + A/M/D 徽标 + 坏帧降级
const parseBlock = extractBlock('function parseFileChanges(')
	.replace(/\(\s*args:\s*ApiBody\s*\)\s*:\s*ChatFileChange\[\]/g, '(args)')
	.replace(/:\s*ChatFileChange\[\]/g, '').replace(/:\s*ApiBody\[\]/g, '')
	.replace(/:\s*ApiBody/g, '').replace(/:\s*string/g, '').replace(/:\s*number/g, '')
	.replace(/ as ChatFileChange/g, '').replace(/ as ApiBody\[\]/g, '');
const changeKindBlock = extractBlock('function changeKind(')
	.replace(/\(\s*raw:\s*string\s*\)\s*:\s*string/g, '(raw)').replace(/:\s*string/g, '');
const statNumberBlock = extractBlock('function statNumber(')
	.replace(/\(\s*value:\s*any \| null\s*\)\s*:\s*number/g, '(value)')
	.replace(/:\s*number/g, '').replace(/ as number/g, '');
const fieldString = (obj, key) => {
	const v = obj == null ? null : obj[key];
	return typeof v === 'string' ? v : '';
};
const parseFileChanges = new Function('fieldString',
	changeKindBlock + '\n' + statNumberBlock + '\n' + parseBlock + '\nreturn parseFileChanges;')(fieldString);
const rows = parseFileChanges({ files: [
	{ path: 'a.ts', changeType: 'MODIFIED', additions: 14, deletions: 5 },
	{ path: 'b.ts', changeType: 'ADDED', additions: 3, deletions: 0 },
	{ path: 'c.ts', changeType: 'DELETED', additions: 0, deletions: 9 },
	{ path: '', changeType: 'ADDED' },
	{ changeType: 'ADDED' },
] });
assert.deepEqual(rows.map((r) => r.kind), ['M', 'A', 'D'], 'changeType must map to M/A/D badges, pathless rows dropped');
assert.equal(rows[0].additions, 14, 'additions must survive parsing');
assert.deepEqual(parseFileChanges({}), [], 'missing files must degrade to empty');
assert.deepEqual(parseFileChanges({ files: 'oops' }), [], 'non-array files must degrade to empty');
assert.deepEqual(parseFileChanges({ files: [{ path: 'x', additions: -3, deletions: 'a' }] })[0].additions, 0,
	'bad stats must clamp to 0, never NaN on screen');

// 12-c) 气泡渲染：fileChanges 卡分支在通用行之前；折叠 3 行；不再渲染协议字段
assert.ok(bubble.indexOf("item.args === 'fileChanges'") < bubble.indexOf('app-chat-bubble__row-head'),
	'the changes-card branch must precede the generic process row');
assert.ok(/visibleChanges\(item\)/.test(bubble) && /item\.changes\.slice\(0, 3\)/.test(bubble),
	'the card must default to 3 rows with an expand toggle (desktop COLLAPSED_ROWS parity)');
assert.ok(/chat\.changes\.more/.test(bubble) && /chat\.changes\.collapse/.test(bubble),
	'the expand/collapse labels must be locale keys');
for (const f of langFiles) {
	const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
	for (const k of ['chat.changes.edited', 'chat.changes.more', 'chat.changes.collapse']) {
		assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
	}
	assert.ok(!('chat.segment.fileChanges' in pack), f + ' must drop the dead fileChanges notice key');
	// v1.1：假附件 key（home.plus.photo / home.plus.attached）必须死；
	// camera/album/file 三个入口复活为真实链路（base64 内联进 input），key 必须在。
	for (const k of ['home.plus.photo', 'home.plus.attached']) {
		assert.ok(!(k in pack), f + ' must drop the dead fake-attachment key ' + k);
	}
	for (const k of ['home.plus.camera', 'home.plus.album', 'home.plus.file']) {
		assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define the real-attachment entry ' + k);
	}
}

// 12-d) 附件入口 v1.1 真实链路：拍照/相册/文件 → attach-picker（压缩+base64）→ input 内联，
// 不再允许「只写名字 tag」的假附件回归。
const plusSheet = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-plus-sheet', 'app-plus-sheet.uvue'), 'utf8');
assert.ok(!/ATTACHMENTS/.test(plusSheet) && !/home\.plus\.photo/.test(plusSheet),
	'the plus sheet must not keep the fake attachment cards (name-only tags with no upload path)');
assert.ok(/emit\('attach', 'camera'\)/.test(plusSheet) && /emit\('attach', 'album'\)/.test(plusSheet) && /emit\('attach', 'file'\)/.test(plusSheet),
	'plus sheet must emit real attach events for camera/album/file');
for (const [label, src] of [['chat', chatSrc], ['home', homeSrc]]) {
	assert.ok(/import \{ pickCamera, pickAlbum, pickFile, mergeAttachments \} from '@\/utils\/attach-picker'/.test(src),
		label + ' must import the real attach picker (with the re-validating merge helper)');
	assert.ok(/@attach="onAttach"/.test(src) && /function onAttach\(kind: string\)/.test(src),
		label + ' must wire the attach handler');
	assert.ok(/pickCamera\(existing\)/.test(src) && /pickAlbum\(existing\)/.test(src) && /pickFile\(existing\)/.test(src),
		label + ' onAttach must dispatch to the three real pickers');
	assert.ok(/sendMessage\((?:conv|created)\.id, content, (?:undefined|created\.ready), atts,/.test(src),
		label + ' must hand pending attachments to sendMessage with a failure-restore callback');
}
// 技能 tag 链路必须保留（attachTag 唯一合法写入方：选技能）。
// 技能选择改为 id + 再点取消后，写入是三元式 `cond ? t('home.skillTag',…) : ''`
// （对象字面量里有分号），断言只钉「写入表达式含 skillTag 文案」，不锁直赋形态。
assert.ok(/attachTag\.value = [^\n]*t\('home\.skillTag'/.test(chatSrc),
	'the skill tag writer must survive (it is the only legitimate attachTag user)');
// attach-picker：真实上传路径三要素（base64 读取、图片压缩、大小上限）
const picker = fs.readFileSync(path.join(__dirname, '..', 'utils', 'attach-picker.ts'), 'utf8');
assert.ok(/getFileSystemManager\(\)/.test(picker) && /readFile/.test(picker) && /base64/.test(picker),
	'attach-picker must read real file bytes as base64 (inline into input, kernel saves them)');
assert.ok(/compressImage/.test(picker), 'attach-picker must compress images before inlining');
assert.ok(/uni\.chooseFile/.test(picker) && /uni\.chooseImage/.test(picker),
	'attach-picker must use system file/image pickers');

// 12-e) markdown 正文：AI 行走 app-md-text；自研纯 UTS 解析器 + 样式管道可执行断言
//（2026-11 用户拍板自研替换 uni-ai-md：原生插件标准基座不生效 + iOS 无实现）
assert.ok(/<app-md-text v-if="!message\.thinking && message\.text\.length > 0 && message\.role === 'ai'"/.test(bubble),
	'AI final text must render through app-md-text (markdown), not a raw text node');
const mdComp = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-md-text', 'app-md-text.uvue'), 'utf8');
assert.ok(/import \{ parseMarkdownBlocks \} from '@\/utils\/markdown-parse\.uts'/.test(mdComp),
	'app-md-text must drive the in-house pure-UTS parser (no native plugin)');
assert.ok(!/uni-ai-md/.test(mdComp) && !/#ifdef APP-ANDROID/.test(mdComp),
	'app-md-text must be platform-uniform (Android/iOS/Harmony/Web share one code path)');
assert.ok(/failed\.value = true/.test(mdComp) && /v-else class="app-md-text__plain"/.test(mdComp),
	'parse failure must fall back to plain text (never a blank body)');
assert.ok(/key: 'md-' \+ i\.toString\(\)/.test(mdComp),
	'block keys must be pinned by index (stable blocks must not rebuild rich-text every frame)');

// prepareMdHtml：strip TS 后直接执行
const mdUtilsSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'markdown-html.ts'), 'utf8');
const mdUtilsJs = mdUtilsSrc
	.replace(/export /g, '')
	.replace(/:\s*Array<\[number, number\]>/g, '')
	.replace(/:\s*string\b/g, '').replace(/:\s*number\b/g, '').replace(/:\s*boolean\b/g, '');
const md = new Function(mdUtilsJs + '\nreturn { prepareMdHtml, findMdOpenTag };')();
const styled = md.prepareMdHtml('<h2>真因</h2><p>这是 <strong>加粗</strong> 与 <code>inline</code></p><pre><code class="language-ts">const a = 1</code></pre>', false);
assert.ok(/<h2 style="[^"]*font-size:18px/.test(styled), 'h2 must get the PC-aligned 18px heading style');
assert.ok(/<strong>加粗<\/strong>/.test(styled), 'inline semantics must survive untouched');
assert.ok(/<pre style="[^"]*background-color:#111827[^"]*"/.test(styled), 'code fences must get the dark block background');
assert.ok(/<code class="language-ts" style="[^"]*color:#e5e7eb/.test(styled),
	'code inside pre must be pinned light-on-dark (rich-text does not inherit color)');
assert.ok(/<code style="[^"]*background-color:rgba\(127,127,127,0\.16\)/.test(styled),
	'inline code outside pre keeps the translucent chip background');
const styledDark = md.prepareMdHtml('<h3>x</h3><blockquote>q</blockquote>', true);
assert.ok(/color:#e8eaed/.test(styledDark), 'dark mode headings must flip to light text');
assert.equal(md.findMdOpenTag('<codex> <code>', 'code', 0), 8, 'tag matcher must not hit prefix collisions like <codex>');
// 流式未闭合 pre：块内 code 仍按块配色（区间延伸到文末）
const tailStyled = md.prepareMdHtml('<pre><code class="language-js">let x =', false);
assert.ok(/color:#e5e7eb/.test(tailStyled), 'an unclosed streaming pre must still color its code light');

// 自研解析器：strip UTS 类型注解后直接执行（编写约束保证 TS/JS 双兼容子集）
const mdParseSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'markdown-parse.uts'), 'utf8');
// 类型剥离只作用于非注释代码：注释里有 `code`/https:// 等字样，
// 全局 /:\s*string/ 一类正则会误伤注释文本把源码撕坏。逐行判断，注释行原样保留。
const mdParseJs = mdParseSrc
	.replace(/export type MdBlock = \{[\s\S]*?\n\}/, '')
	.replace(/type MdListMark = \{[\s\S]*?\n\}/, '')
	.split('\n')
	.map((line) => {
		const t = line.trim();
		if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return line;
		return line
			.replace(/export /g, '')
			.replace(/:\s*MdBlock\[\]/g, '').replace(/:\s*MdBlock\b/g, '')
			.replace(/:\s*MdListMark\b/g, '')
			.replace(/:\s*string\[\]\[\]/g, '').replace(/:\s*string\[\]/g, '')
			.replace(/:\s*number\[\]/g, '')
			.replace(/:\s*string\b/g, '').replace(/:\s*number\b/g, '').replace(/:\s*boolean\b/g, '')
			.replace(/\bas MdBlock\b/g, '').replace(/\bas MdListMark\b/g, '');
	})
	.join('\n');
const mp = new Function(mdParseJs + '\nreturn { parseMarkdownBlocks };')();
// 块级：标题/加粗/行内 code/围栏
const doc = mp.parseMarkdownBlocks('# 标题\n\n这是 **加粗** 与 `inline`\n\n```ts\nconst a = 1\n```', true);
assert.ok(doc.length === 3, 'three blocks expected (heading/paragraph/fence), got ' + doc.length);
assert.ok(/^<h1>标题<\/h1>$/.test(doc[0].html), 'ATX heading must render as h1');
assert.ok(/<strong>加粗<\/strong>/.test(doc[1].html) && /<code>inline<\/code>/.test(doc[1].html),
	'bold and inline code must render inside paragraphs');
assert.ok(/<pre><code class="language-ts">const a = 1<\/code><\/pre>/.test(doc[2].html),
	'fenced code must keep the language class and escape-free body');
// 列表（含嵌套）/引用/表格/分隔线/setext
const doc2 = mp.parseMarkdownBlocks('- a\n- b\n  - b1\n\n> 引用 **重点**\n\n| A | B |\n| --- | :-: |\n| 1 | 2 |\n\n---\n\nSetext\n===', true);
assert.ok(/<ul><li>a<\/li><li>b<ul><li>b1<\/li><\/ul><\/li><\/ul>/.test(doc2[0].html),
	'nested unordered lists must render as nested ul/li');
assert.ok(/<blockquote><p>引用 <strong>重点<\/strong><\/p><\/blockquote>/.test(doc2[1].html),
	'blockquotes must wrap parsed inner blocks');
assert.ok(/<table><thead><tr><th>A<\/th><th style="text-align:center;">B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td style="text-align:center;">2<\/td><\/tr><\/tbody><\/table>/.test(doc2[2].html),
	'pipe tables must render with alignment styles');
assert.ok(doc2[3].html === '<hr/>', 'thematic break must render as hr');
assert.ok(doc2[4].html === '<h1>Setext</h1>', 'setext underline must render as heading');
// 有序列表 start / 删除线 / 链接与自动链接 / 图片 / 转义 / 注入防护
const doc3 = mp.parseMarkdownBlocks('3. three\n4. four\n\n~~gone~~ [官网](https://x.dev) https://auto.dev/x\n\n![图](https://x.dev/a.png) \\*literal\\* <b>raw</b> [bad](javascript:alert(1))', true);
assert.ok(/<ol start="3"><li>three<\/li><li>four<\/li><\/ol>/.test(doc3[0].html), 'ordered lists must keep the start number');
assert.ok(/<del>gone<\/del>/.test(doc3[1].html) && /<a href="https:\/\/x\.dev">官网<\/a>/.test(doc3[1].html)
	&& /<a href="https:\/\/auto\.dev\/x">https:\/\/auto\.dev\/x<\/a>/.test(doc3[1].html),
	'strikethrough, explicit links and bare autolinks must render');
assert.ok(/<img src="https:\/\/x\.dev\/a\.png" alt="图"\/>/.test(doc3[2].html), 'images must render as img tags');
assert.ok(/\*literal\*/.test(doc3[2].html) && /&lt;b&gt;raw&lt;\/b&gt;/.test(doc3[2].html),
	'backslash escapes and raw HTML must be escaped (no injection)');
assert.ok(!/javascript:/.test(doc3[2].html) && / bad<\/p>/.test(doc3[2].html),
	'javascript: links must degrade to plain label text');
// snake_case 不被下划线斜体误伤；词内 * 同理
const doc4 = mp.parseMarkdownBlocks('snake_case_name 与 *em* 和 _em_', true);
assert.ok(/snake_case_name/.test(doc4[0].html) && /<em>em<\/em>/.test(doc4[0].html),
	'intra-word underscores must stay literal while real emphasis renders');
// 流式：未闭合围栏成尾块（stable=false）；收口后 stable=true；稳定块跨帧不变
const stream1 = mp.parseMarkdownBlocks('# t\n\n```js\nlet x =', false);
assert.ok(stream1.length === 2 && stream1[0].stable === true && stream1[1].stable === false,
	'streaming: closed blocks stay stable, the open fence is the unstable tail');
assert.ok(/<pre><code class="language-js">let x =<\/code><\/pre>/.test(stream1[1].html),
	'an unclosed streaming fence must still render as a code block');
const stream2 = mp.parseMarkdownBlocks('# t\n\n```js\nlet x = 1\n```\n\n后续', false);
assert.ok(stream2[0].html === stream1[0].html && stream2[1].stable === true
	&& stream2[1].html === '<pre><code class="language-js">let x = 1</code></pre>',
	'once the fence closes it becomes a stable block with a fixed index');
const stream3 = mp.parseMarkdownBlocks('# t\n\n```js\nlet x = 1\n```\n\n后续', true);
assert.ok(stream3.every((b) => b.stable === true), 'complete=true must mark every block stable');
// 空文本/纯空白 → 空数组（组件回退纯文本分支）
assert.equal(mp.parseMarkdownBlocks('', true).length, 0, 'empty text must produce no blocks');
assert.equal(mp.parseMarkdownBlocks('  \n\n', false).length, 0, 'blank text must produce no blocks');
// CRLF 归一
assert.ok(/<p>a b<\/p>|<p>a<br\/>b<\/p>/.test(mp.parseMarkdownBlocks('a\r\nb', true)[0].html),
	'CRLF must normalize to LF before parsing');
// ---- code review 修复回归（2026-11 二轮评审，全部实证复现后修复）----
// a) 图片协议校验：javascript: 图片必须降级为 alt 文本（曾是注入口子）
assert.ok(mp.parseMarkdownBlocks('![x](javascript:alert(1))', true)[0].html === '<p>x</p>',
	'javascript: image sources must degrade to alt text (was an injection hole)');
// b) 自动链接 scheme 白名单：javascript://、data:// 伪装 scheme 不得成链
const schemeDoc = mp.parseMarkdownBlocks('<javascript://x> <data://x> <https://ok.dev>', true)[0].html;
assert.ok(!/href="javascript/.test(schemeDoc) && !/href="data/.test(schemeDoc) && /href="https:\/\/ok\.dev"/.test(schemeDoc),
	'autolinks must enforce a scheme allowlist (javascript:// masquerade must stay literal)');
// c) 中文 autolink 边界（PC gourdAutoLinkExtension 同款）：URL 不得吞掉紧随的汉字/全角标点
const cnDoc = mp.parseMarkdownBlocks('详见 https://x.dev/a，后续中文说明', true)[0].html;
assert.ok(/href="https:\/\/x\.dev\/a"/.test(cnDoc) && /，后续中文说明/.test(cnDoc) && !/href="[^"]*[\u4e00-\u9fff]/.test(cnDoc),
	'autolink must stop at CJK chars/punctuation (RFC3986 ASCII only, PC parity)');
// d) 强调闭标记前邻空白不合格：宁可不渲染也不吞错内容
const emDoc = mp.parseMarkdownBlocks('~~a ~~b~~', true)[0].html;
assert.ok(/~~a <del>b<\/del>/.test(emDoc), 'a closer preceded by whitespace must not capture earlier content');
// e) em 扫描跳过双标记：**x **y** 不得把第二个 opener 的一半错配成 em 闭标记
const dblDoc = mp.parseMarkdownBlocks('**x **y**', true)[0].html;
assert.ok(!/<em>/.test(dblDoc), 'italic scan must skip double-marker runs (no opener/closer mismatch)');
// f) 引用嵌套封顶：200 层 ">" 不得递归爆栈，超限按字面文本保真
let deepQuote = '';
for (let d = 0; d < 200; d++) deepQuote += '>';
const deepDoc = mp.parseMarkdownBlocks(deepQuote + ' x', true);
assert.ok(deepDoc.length === 1 && /^<p>&gt;/.test(deepDoc[0].html),
	'quote nesting must be capped (200-level ">" must not blow the recursion stack)');
assert.ok(/<blockquote><blockquote><p>/.test(mp.parseMarkdownBlocks('> > deep', true)[0].html),
	'shallow nested quotes must still render');
// g) 列表消费终点单一来源：mdListEnd 双实现必须已删除（漂移风险）
assert.ok(!/function mdListEnd/.test(mdParseSrc) && /endOut\.push\(i\)/.test(mdParseSrc),
	'list consumption endpoint must come from mdParseList itself (dual boundary logic removed)');
// h) 列表边界回归：嵌套/松列表/懒惰续行经 endOut 推进后行为不变
const listDoc = mp.parseMarkdownBlocks('- a\n- b\n  - b1\n\n- c\n\n尾段', true);
assert.ok(listDoc.length === 2
	&& /<ul><li><p>a<\/p><\/li><li><p>b<\/p><ul><li>b1<\/li><\/ul><\/li><li><p>c<\/p><\/li><\/ul>/.test(listDoc[0].html)
	&& listDoc[1].html === '<p>尾段</p>',
	'list blocks must consume exactly their own lines via endOut (loose list wraps items in <p>)');
const tightDoc = mp.parseMarkdownBlocks('- a\n- b\n  - b1\n\n尾段', true);
assert.ok(tightDoc.length === 2 && /<ul><li>a<\/li><li>b<ul><li>b1<\/li><\/ul><\/li><\/ul>/.test(tightDoc[0].html),
	'tight lists keep inline heads via endOut advancement');
// i) HTML 注释行不渲染（2026-11 用户报障「框里裸露 稳定块渲染缓存 注释文本」）：
//    完整注释（含跨行）整段剥离；围栏代码里的 <!-- 字面量保真；
//    流式未闭合注释暂可见（转义），闭合帧到达即消失；段落不得懒惰吸收注释行。
const cmDoc = mp.parseMarkdownBlocks('<!-- 稳定块渲染缓存 -->\n\n正文 **重点**', true);
assert.ok(cmDoc.length === 1 && cmDoc[0].html === '<p>正文 <strong>重点</strong></p>',
	'complete HTML comment lines must be stripped (never escaped into visible text)');
const cmMulti = mp.parseMarkdownBlocks('<!-- 稳定块渲染缓存\n跨行注释 -->\n尾巴', true);
assert.ok(cmMulti.length === 1 && cmMulti[0].html === '<p>尾巴</p>',
	'multi-line comments must be consumed as one unit');
const cmFence = mp.parseMarkdownBlocks('```html\n<!-- 示例注释 -->\n<div>x</div>\n```', true);
assert.ok(/&lt;!-- 示例注释 --&gt;/.test(cmFence[0].html),
	'comment literals inside code fences must stay verbatim (escaped, visible)');
const cmStream = mp.parseMarkdownBlocks('正文\n\n<!-- 未闭合注释', false);
assert.ok(cmStream.some((b) => b.html.indexOf('&lt;!--') >= 0),
	'an unclosed streaming comment stays visible (escaped) until its closer arrives');
const cmPara = mp.parseMarkdownBlocks('第一段\n<!-- 注释 -->\n第二段', true);
assert.ok(cmPara.length === 2 && cmPara[0].html === '<p>第一段</p>' && cmPara[1].html === '<p>第二段</p>',
	'paragraph lazy continuation must not absorb comment lines');
// i2) 【评审修复】注释闭合后的行尾内容不得随注释一起被吞（正文缺字比重复渲染更严重）
const cmTail = mp.parseMarkdownBlocks('<!-- c -->尾巴', true);
assert.ok(cmTail.length === 1 && cmTail[0].html === '<p>尾巴</p>',
	'text after the comment closer on the same line must survive (single-line)');
const cmTailMulti = mp.parseMarkdownBlocks('<!-- a\nb -->尾巴\n\n下一段', true);
assert.ok(cmTailMulti.length === 2 && cmTailMulti[0].html === '<p>尾巴</p>' && cmTailMulti[1].html === '<p>下一段</p>',
	'text after the closer on the closing line must survive (multi-line)');
// 无空行时尾巴与后续行按 CommonMark 段落懒惰续行合并（不丢字即可）
const cmTailLazy = mp.parseMarkdownBlocks('<!-- a\nb -->尾巴\n下一段', true);
assert.ok(cmTailLazy.length === 1 && /尾巴/.test(cmTailLazy[0].html) && /下一段/.test(cmTailLazy[0].html),
	'lazy continuation after the rewritten tail must keep both lines');
// 行尾是列表标记时按列表消费（改写后的行重新走块分派，不是只能落段落）
const cmTailList = mp.parseMarkdownBlocks('<!-- c -->- 项目', true);
assert.ok(cmTailList.length === 1 && /^<ul><li>项目<\/li><\/ul>$/.test(cmTailList[0].html),
	'the rewritten tail line must re-enter block dispatch (list marker honored)');

// 12-e1b) PC createStreamMd 借鉴（2026-11 用户拍板：稳定块缓存 + 合帧节流）
const convSrcEarly = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
// 稳定块样式缓存：三重命中校验（序号+语义HTML+主题），收口帧全量重算纠偏
assert.ok(/stableCache/.test(mdComp) && /hit!\.src === b\.html && hit!\.dark === isDark\.value/.test(mdComp),
	'stable block styling must be cached with src+dark validation (PC createStreamMd parity)');
assert.ok(/if \(props\.complete && !lastComplete\) stableCache = \[\]/.test(mdComp),
	'the settle frame must rebuild all blocks (PC finish() full re-render parity)');
// 合帧节流：delta 逐帧累积、可见写入 120ms 合并；首段立即上屏；终态/边界强制落账
assert.ok(/const TEXT_FLUSH_MS = 120/.test(convSrcEarly) && /function bufferFinalText/.test(convSrcEarly)
	&& /bufferFinalText\(conv\.id, msg, delta, block!\)/.test(convSrcEarly),
	'final-text deltas must be coalesced (~120ms) instead of per-frame view writes');
assert.ok(/const first: boolean = block\.body\.length === 0 && buf!\.pending\.length === 0/.test(convSrcEarly),
	'the first delta must paint immediately (no first-token latency from throttling)');
assert.ok(/if \(kind !== 'text'\) flushTextBuf\(sessionId\)/.test(convSrcEarly),
	'any non-text frame must flush pending text first (tool cards never precede a truncated body)');
assert.ok(/function discardPartialAttempt[\s\S]{0,300}dropTextBuf\(conv\.id\)/.test(convSrcEarly),
	'retry discard must drop (not flush) the failed attempt buffer');
assert.ok(/function resetTurnState[\s\S]{0,260}dropTextBuf\(id\)/.test(convSrcEarly),
	'turn reset must invalidate the coalescing buffer');
assert.ok(/function finishProcessingTail[\s\S]{0,300}flushTextBuf\(conv\.id\)/.test(convSrcEarly)
	&& /textBufs\.forEach\(\(buf: TextBuf, id: string\): void => \{\s*if \(buf\.msg === msg\) flushTextBuf\(id\)/.test(convSrcEarly),
	'settle paths (finishProcessingTail/compactTurn) must flush before reading msg.text');
assert.ok(/buf!\.msg = msg/.test(convSrcEarly) && /const msg: ChatMessage \| null = buf\.msg != null \? buf\.msg : lastAiMessage\(conv\)/.test(convSrcEarly),
	'flush must target the pinned message (never leak deltas into a newer bubble)');
assert.ok(/dropTextBuf\(id\)[\s\S]{0,80}offFrame\(id\)|offFrame\(id\)[\s\S]{0,80}dropTextBuf\(id\)/.test(convSrcEarly)
	&& /textBufs\.forEach\(\(_buf: TextBuf, id: string\): void => \{ dropTextBuf\(id\) \}\)/.test(convSrcEarly),
	'conversation removal and device switch must clear coalescing timers');

// 12-e2) 思考/工具【卡体】默认折叠（2026-11 用户拍板 + 澄清）：行 body 点击才展开；
// 批次盖子运行中必须默认【展开】（PC createHeader data-batch-open='true' 同款），
// closeBatch 收口后才折叠——「默认收起」曾被错误实现成开盖即折叠，
// 用户实机报障「正在执行的收起来了」，此处钉死两个方向防再回退。
const convSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
assert.ok(/head\.batchCollapsed = false/.test(convSrc),
	'running batches must be born EXPANDED (PC parity; collapse-on-birth hid the live process)');
assert.ok(/head\.batchCollapsed = true/.test(convSrc),
	'closeBatch must collapse the batch when the run settles');
assert.ok(/rowOpen: false/.test(convSrc), 'process rows must default to collapsed bodies');
assert.ok(/v-else-if="item\.rowOpen && item\.body\.length > 0"/.test(bubble) && /function onToggleRow\(item: ChatBlock\)/.test(bubble),
	'row bodies must render only when rowOpen and toggle via the row head tap');
assert.ok(!/v-if="item\.body\.length > 0" class="app-chat-bubble__row-body"/.test(bubble),
	'the always-expanded row body must not regress');
// 12-e3) 正文按帧时序分段（2026-11 用户报障「产物卡片跑到正文上面 + 过程框裸露 markdown 原文」）：
// ① text 帧落成独立 'text' 段块（位置=帧时序），过程帧收口当前段（closeTextSegment），
//    收口时最后一段提升为 msg.text（promoteLastTextSegment）——绝不把全部正文攒进
//    msg.text 再把过程区整体渲染在正文上方（旧实现 = 卡片上移真因）；
// ② 'text' 段块必须走 app-md-text markdown 渲染（与最终正文同管道），不得纯文本 dump。
assert.ok(/function closeTextSegment\(conv: Conversation\)/.test(convSrc)
	&& /function promoteLastTextSegment\(conv: Conversation, msg: ChatMessage\)/.test(convSrc)
	&& /if \(processKind\) \{[\s\S]{0,200}closeTextSegment\(conv\)/.test(convSrc),
	'text must segment by frame order: process frames close the active segment, settle promotes the last one to msg.text');
assert.ok(/state\.textKey/.test(convSrc) && !/state\.textBoundary/.test(convSrc),
	'the old whole-body-to-process migration (textBoundary) must be gone');
// 【⑳ Qoder 层级】渲染路径扩为三条：限高滚动窗 / 平铺批次 group（带引导线+缩进）/
// 常驻行平铺——每条都必须走 markdown 管道，计数钉死为 3。
assert.ok((bubble.match(/v-if="item\.kind === 'text' && item\.body\.length > 0" class="app-chat-bubble__process-md"/g) || []).length === 3,
	'all three render paths (windowed + batched-flat group + resident-flat) must render process text segments via markdown (app-md-text), never raw-text dump');
assert.ok((bubble.match(/<app-md-text :text="item\.body"/g) || []).length === 3,
	'process text segments must use the same markdown pipeline as the final body');
// 12-e4) 【评审修复】收口提升按「可见内容」判定：纯 HTML 注释段（渲染态为空）
// 不得被提升为 msg.text——否则气泡只剩「已完成」，真回答被 Compact 藏进过程区
assert.ok(/function hasVisibleContent\(body: string\): boolean/.test(convSrc)
	&& /item\.kind === 'text' && hasVisibleContent\(item\.body\)/.test(convSrc)
	&& /if \(hasVisibleContent\(block!\.body\)\) state\.texts \+= 1/.test(convSrc),
	'promotion/counting must skip comment-only text segments (visible-content check)');
// 12-e5) 【评审修复】'text' 过程正文段恒渲染（不随 rowOpen 折叠）：
// 滚动窗高度估算与内容签名都必须始终计入其 body，否则长正文段误走平铺撑爆气泡
assert.ok(/\(item\.rowOpen \|\| item\.kind === 'text'\) \? Math\.min\(item\.body\.length, 2400\) : 0/.test(bubble)
	&& /if \(item\.rowOpen \|\| item\.kind === 'text'\) w \+= Math\.min\(item\.body\.length, 2400\)/.test(bubble),
	'always-rendered text segments must count toward window height estimate and follow signature');

// 12-f) 包体瘦身：无引用的重型模块必须不存在；manifest 锁定 arm64
// uni-ai-md（10.8MB 原生 so/har）已随自研解析器落地整体移除：标准基座不生效 + iOS 无实现
for (const dead of ['uni-ai-x', 'uni-highlight', 'uni-cmark', 'uni-icons', 'uni-popup', 'uni-transition', 'uni-upgrade-center-app', 'uts-openSchema', 'uts-progressNotification', 'uni-scss', 'uni-ai-md']) {
	assert.ok(!fs.existsSync(path.join(__dirname, '..', 'uni_modules', dead)),
		'unreferenced module ' + dead + ' must stay deleted (it inflated the APK)');
}
assert.ok(Array.isArray(androidNode.distribute.abiFilters) && androidNode.distribute.abiFilters.includes('arm64-v8a')
	&& androidNode.distribute.abiFilters.length === 1,
	'Android packaging must pin arm64-v8a only (32-bit runtime was dead weight)');
console.log('PASS  msg-display: per-run changes card (no manifest dump), real v1.1 inline attachments (picker->base64->input), markdown body via in-house pure-UTS parser + styled rich-text (all platforms, plain-text fallback), default-collapsed thinking/tool rows, 29.4MB dead modules purged + arm64-only ABI');

/* ---------------- 13) 批次限高滚动窗（2026-11 用户拍板：运行中/历史展开限高 ≈8 行内部滚动） ----------------
   PC app-turn-display.js WINDOW_MAX_PX=232 同款语义。UCSS 无 overflow:scroll，
   必须真 scroll-view；以下钉死链路四要素，防「改了但看起来没改」回归。 */
// 13-a) 分段渲染：批次盖子 + 成员成段，windowed 段进 scroll-view
assert.ok(/type BubbleSegment = \{/.test(bubble) && /const segments: ComputedRef<BubbleSegment\[\]>/.test(bubble),
	'the bubble must group blocks into batch segments (head + members)');
// 【⑳ Qoder 层级】scroll-view 外包 group 容器画引导线，v-if 移到 group 上且
// 要求有真实成员（空批次不建窗不画线）；scroll-view 本体只保留 id/class/高度绑定。
assert.ok(/v-if="seg\.windowed && seg\.members\.length > 0" class="app-chat-bubble__group"/.test(bubble)
	&& /<scroll-view :id="'tbwin-' \+ seg\.key" class="app-chat-bubble__batch-window"/.test(bubble),
	'windowed segments must render inside a real scroll-view (UCSS has no overflow:scroll), wrapped by the guide-line group');
// 【2026-11 实机报障「已处理与正在执行中之间一大段空白」】uni-app x 纵向 scroll-view
// 无确定高度时按默认高度布局，max-height 只裁内容不定容器 → 成员少时容器留白。
// 必须显式给高：windowStyle = min(内容估算+2, WINDOW_MAX_PX=232)，且 CSS 不得再依赖 max-height。
assert.ok(/const WINDOW_MAX_PX = 232/.test(bubble)
	&& /function windowStyle\(seg: BubbleSegment\): string/.test(bubble)
	&& /Math\.min\(seg\.estHeight \+ 2, WINDOW_MAX_PX\)/.test(bubble)
	&& /:style="windowStyle\(seg\)"/.test(bubble),
	'the batch window must carry an explicit content-fitted height capped at 232px (PC WINDOW_MAX_PX parity)');
assert.ok(!/max-height: 232px/.test(bubble),
	'max-height alone leaves the scroll-view at its default height (the big blank gap between batch headers)');
// 13-b) 常驻行绝不进滚动窗：agent 徽章/无归属行独立成段
assert.ok(/item\.kind !== 'agent'/.test(bubble),
	'agent badges must never be swallowed into the batch scroll window');
// 13-c) 贴底跟随 + 上滑暂停 + 触底恢复
assert.ok(/function followBottom\(key: string\)/.test(bubble) && /winPinned/.test(bubble),
	'the window must auto-follow the bottom while pinned');
assert.ok(/@scroll="onWindowScroll\(seg\.key, \$event\)"/.test(bubble) && /@scrolltolower="onWindowLower\(seg\.key\)"/.test(bubble),
	'user scroll must pause the follow; hitting the lower edge must resume it');
assert.ok(/watch\(windowSig/.test(bubble),
	'content growth (new steps / longer bodies) must re-trigger the pinned follow');
// 13-d) scroll-top 限幅震荡（list-view 同款经验：持续递增会累计到数百万）
assert.ok(/cur > 100000 \? 100000 : 200000/.test(bubble),
	'scroll-top follow must oscillate between bounded values (never accumulate)');
console.log('PASS  batch-window: segments + capped scroll-view (232px), pinned auto-follow with scroll pause/resume, agent rows stay outside');

/* ---------------- 13-e) 过程区列对齐 + 展开缩进（2026-11 用户报障「总折叠有遮挡、
   展开后下面的缩进都在上面的前面」）：
   ① 摘要行/批次盖子/成员行的文本列必须同列——前导件（箭头 7×7+ml2+mr6 / 图标槽 13）
     右缘恒 15px，label 不得再各自加 margin-left；
   ② 展开的 row-body 左缩进（margin-left）必须真实生效——UCSS 下 margin/padding
     简写解析不可靠（同 margin-left:auto 教训），简写静默失效时全文从屏缘顶格、
     与上一行行头叠成一团（截图「遮挡」的来源），故钉死单边写法；
   ③ 字体图标必须进定宽槽（字形宽度随字体漂移会让同批行文本列参差）。 */
{
	const stylePart = bubble.slice(bubble.indexOf('<style'));
	// ① 盖子 label 独立规则不得带 margin-left（旧共享规则的 7px 曾让盖子比成员右缩 7px）
	const batchLabelRule = stylePart.slice(stylePart.indexOf('&__batch-label {'));
	const batchLabelBody = batchLabelRule.slice(0, batchLabelRule.indexOf('}'));
	assert.ok(!/margin-left/.test(batchLabelBody),
		'batch head label must not add margin-left: its text column must align with compact/member labels (leading slot ends at 15px)');
	assert.ok(/font-size: 13px/.test(batchLabelBody) && /line-height: 21px/.test(batchLabelBody),
		'batch head label must keep 13px/21px typography after the shared rule split');
	assert.ok(/&__row-label \{[\s\S]{0,120}margin-left: 7px/.test(stylePart),
		'member row label keeps margin-left 7px after the 13px icon slot (text column at 22px)');
	// ② row-body 的左缩进与上下间距必须是单边写法，且不得回潮四值简写
	assert.ok(/&__row-body \{[\s\S]{0,200}margin-left: 20px/.test(stylePart),
		'expanded row body must indent via single-side margin-left (shorthand silently drops on UCSS -> overlap at screen edge)');
	assert.ok(!/margin: \d+px \d+px \d+px \d+px/.test(stylePart),
		'four-value margin shorthand must not regress anywhere in the bubble (UCSS parsing is unreliable)');
	assert.ok(!/padding: \d+px \d+px;/.test(stylePart.slice(stylePart.indexOf('&__compact {'), stylePart.indexOf('&__error {'))) && !/padding: \d+px \d+px;/.test(stylePart.slice(stylePart.indexOf('&__row-body {'), stylePart.indexOf('&__meta {'))),
		'compact/batch/row-head/row-body paddings must stay single-side (column geometry must not depend on shorthand)');
	// ③ 字体图标定宽槽存在，且模板两处（滚动窗/平铺）都不再有裸 rice-icon 行
	assert.ok(/&__row-icon \{[\s\S]{0,160}width: 13px/.test(stylePart),
		'font icons need a fixed 13px slot so the row text column never drifts with glyph width');
	assert.ok(!/<rice-icon v-else/.test(bubble) && (bubble.match(/class="app-chat-bubble__row-icon"/g) || []).length === 3,
		'all three render paths (windowed + batched-flat group + resident-flat) must wrap rice-icon in the fixed slot');
}
console.log('PASS  process-align: unified 15px leading slot (compact/batch/member), single-side margins keep expanded body indented, fixed font-icon slot');

/* ---------------- 13-f) 摘要 chips 定稿（2026-11 用户拍板「前面用图标，后面加上对应数字」）：
   ① compactTurn 只落状态+耗时短头；counts 必须含 texts（过程文本 chip 数据源）；
   ② 气泡层 summaryChips 按 counts>0 出 chip（图标+数字），零计数不占位；
   ③ 摘要头 label 单行截断（white-space:nowrap，UCSS lines 已废弃），不再 flex:1 吃满整行；
   ④ chip 图标 13px 定宽 + flex-shrink:0，数字 12px——四类全出也单行放得下。 */
{
	assert.ok(/counts: \{ tools: number; reasons: number; agents: number; batches: number; texts: number \}/.test(dataModel),
		'ChatMessage.counts must carry texts (process-text chip source)');
	assert.ok(/const summaryChips: ComputedRef<SummaryChip\[\]>/.test(bubble) && /v-for="chip in summaryChips"/.test(bubble),
		'the compact row must render icon+count chips from summaryChips');
	assert.ok(/if \(c\.tools > 0\)/.test(bubble) && /if \(c\.reasons > 0\)/.test(bubble) && /if \(c\.agents > 0\)/.test(bubble) && /if \(c\.texts > 0\)/.test(bubble),
		'zero-count categories must not emit chips');
	assert.ok(/processTextIconUri/.test(bubble) && /export function processTextIconUri/.test(fs.readFileSync(path.join(__dirname, '..', 'utils', 'tool-presentation.ts'), 'utf8')),
		'the process-text chip needs its own PC-family document icon');
	const stylePart2 = bubble.slice(bubble.indexOf('<style'));
	const compactLabelRule = stylePart2.slice(stylePart2.indexOf('&__compact-label {'));
	const compactLabelBody = compactLabelRule.slice(0, compactLabelRule.indexOf('}'));
	assert.ok(/white-space: nowrap/.test(compactLabelBody) && !/flex: 1/.test(compactLabelBody) && !/lines: 1/.test(compactLabelBody),
		'compact head label must be single-line ellipsis (nowrap, not the deprecated UCSS lines) and shrink to content, leaving room for chips');
	assert.ok(/&__chip \{[\s\S]{0,200}flex-shrink: 0/.test(stylePart2) && /&__chip-icon \{[\s\S]{0,120}width: 13px/.test(stylePart2),
		'chips must not shrink and icons need the fixed 13px slot');
	// code review 修复：图标语义提示必须真实存在——原生 image/text 无 title 能力，
	// 注释里声称的「title 提示」曾是空头支票；定稿为长按 chip 弹 chat.turn.* toast，
	// .stop 阻断冒泡（长按不得顺带折叠整轮）。四类 tipKey 必须在 12 语言包里齐活。
	assert.ok(/@longpress\.stop="onChipTip\(chip\)"/.test(bubble) && /function onChipTip\(chip: SummaryChip\)/.test(bubble)
		&& /uni\.showToast\(\{ title: t\(chip\.tipKey, \{ n: chip\.count \}\), icon: 'none' \}\)/.test(bubble),
		'chips must expose a real long-press tooltip toast (native views have no title attribute)');
	for (const tipKey of ['chat.turn.tools', 'chat.turn.reasons', 'chat.turn.agents', 'chat.turn.texts']) {
		assert.ok(bubble.includes("tipKey: '" + tipKey + "'"), 'summary chip must carry tipKey ' + tipKey);
		for (const f of fs.readdirSync(path.join(__dirname, '..', 'locale')).filter((n) => n.endsWith('.json'))) {
			const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locale', f), 'utf8'));
			assert.ok(typeof pack[tipKey] === 'string' && pack[tipKey].includes('{n}'),
				'locale ' + f + ' must define ' + tipKey + ' with {n} placeholder (chip tooltip)');
		}
	}
}
console.log('PASS  summary-chips: compact head is status+elapsed only, counts render as icon+number chips (zero hidden, single-line, fixed icon slot, real long-press tooltip)');

/* ---------------- 14) 权限入口定稿（2026-11 用户拍板）：头部不露权限段；
   运行弹层里工作空间+权限模式同组一张卡；切「允许完全访问」必须二次确认 ---------------- */
// 14-a) env-bar 只剩 设备|工作空间 两段（权限段及其 danger 态彻底移除）
const envBar = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-env-bar', 'app-env-bar.uvue'), 'utf8');
assert.ok(!/permission/i.test(envBar),
	'the header env bar must not carry any permission segment (user-final: permission lives in the run sheet only)');
const header = fs.readFileSync(path.join(__dirname, '..', 'pages', 'home', 'components', 'home-header.uvue'), 'utf8');
// run-sheet 仍需 :permission（弹层内展示/切换）；只禁 env-bar / home-header 收权限 prop
const envBarTags = (homeSrc + chatSrc).match(/<app-env-bar[\s\S]*?>/g) || [];
for (const tag of envBarTags) {
	assert.ok(!/:permission=/.test(tag), 'app-env-bar callers must not pass permission anymore');
}
assert.ok(!/permission/.test(header), 'home-header must not carry a permission prop');
// 14-b) run-sheet：工作空间+权限模式同组卡（细分隔线），权限行任何态可调
const runSheet = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-run-sheet', 'app-run-sheet.uvue'), 'utf8');
assert.ok(/class="app-run__group"/.test(runSheet) && /app-run__group-sep/.test(runSheet),
	'workspace + permission must share one grouped card with a divider (user-final layout)');
assert.ok(/home\.run\.workspace/.test(runSheet) && /home\.run\.permission/.test(runSheet),
	'the grouped card must keep both rows');
// 14-c) 完全访问二次确认（showModal，取消停留原档），4 个 key × 12 语种齐备
assert.ok(/function onPickPermission/.test(runSheet) && /uni\.showModal/.test(runSheet)
	&& /home\.permission\.confirmTitle/.test(runSheet) && /if \(r\.confirm\)/.test(runSheet),
	'switching to full access must require an explicit confirm dialog (cancel keeps the old mode)');
for (const f of langFiles) {
	const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
	for (const k of ['home.permission.confirmTitle', 'home.permission.confirmBody', 'home.permission.confirmOk', 'home.permission.confirmCancel']) {
		assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
	}
}
// 14-d) 提交链路不回退：会话内 access/select 立即持久化 + 每条 input 带 accessMode
const envHook = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useRunEnv.ts'), 'utf8');
assert.ok(/access\/select/.test(envHook) && /accessMode/.test(envHook),
	'permission changes must still persist via access/select and ride every input');
console.log('PASS  permission-ux: header segment removed, workspace+permission grouped card, full-access confirm dialog (12 langs), access/select chain intact');

/* ---------------- 15) codereview 修复轮（P0/P1）防回归哨兵 ---------------- */
const pickerSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'attach-picker.ts'), 'utf8');
const plusSheetSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-plus-sheet', 'app-plus-sheet.uvue'), 'utf8');

// 15-a) P0-1 权限 per-session + 协议码：ModelConfig 带 permission；bindSession/换设备/新建对话复位；
//       accessMode 回读在欢迎态/缓存闸门之前；PERMISSIONS 用稳定码值不用中文展示名
assert.ok(/permission:\s*string/.test(envHook), 'ModelConfig must carry the per-session permission code');
assert.ok(/name: 'default'/.test(dataModel) && /name: 'full'/.test(dataModel),
    'PERMISSIONS must use stable wire codes, not localized display names');
assert.ok(!/默认权限|允许完全访问/.test(dataModel), 'no hard-coded Chinese permission labels in the data model');
const bindFn = extractBlockEnv('function bindSession(');
assert.ok(/permission\.value = cached != null \? cached\.permission : PERMISSIONS\[0\]\.name/.test(bindFn),
    'bindSession must restore the per-session permission (default when uncached), never carry the previous session over');
assert.ok(/welcomeHasLocalSelection\) return/.test(envHook), 'model gate still exists');
const applySelFn = extractBlockEnv('function applySelection(');
assert.ok(applySelFn.indexOf('accessMode') < applySelFn.indexOf('welcomeHasLocalSelection'),
    'accessMode echo must run BEFORE the welcome/cache gate (P0: full mode leaked across sessions)');
assert.ok(/permission\.value = PERMISSIONS\[0\]\.name/.test(envHook), 'device switch / new chat must reset permission to default');
assert.ok(/export function permissionLabel\(/.test(envHook), 'UI labels must go through permissionLabel (i18n), not raw codes');
assert.ok(/permissionLabel\(permission\)/.test(runSheet), 'run sheet must render the localized permission label');

// 15-b) P0-2 文本兜底仅限无 id 帧：带 id 且不等的 user 帧必须渲染（他端消息不可吞）。
// 注意第一个 pendingUserEcho.get 是身份分支的 sentText 覆盖读取，文本兜底是第二个。
const fallbackAt = userBranch.indexOf('const echo: string | undefined = pendingUserEcho.get(sessionId)');
const noIdGateAt = userBranch.indexOf('echoMsgId.length === 0');
assert.ok(noIdGateAt !== -1 && fallbackAt !== -1 && noIdGateAt < fallbackAt,
    'the text fallback must be gated on echoMsgId.length === 0 (frames with a different id are foreign messages)');

// 15-c) P1-1/3 失败回填 + 按行 id 回滚：sendMessage 带 onFail；rollback 按 optimisticUserId 定位
assert.ok(/onFail\?: \(text: string, atts: PendingAttachment\[\]\) => void/.test(SRC),
    'sendMessage must accept an onFail restore callback');
assert.ok(/optimisticUserId\.set\(clientMsgId, userMsg\.id\)/.test(SRC),
    'the optimistic user row must be bound to the send identity');
const rollbackFn = extractBlock('function rollbackOptimisticSend(');
assert.ok(/optimisticUserId\.get\(clientMsgId\)/.test(rollbackFn) && !/userTail\.text === content/.test(rollbackFn),
    'rollback must locate the row by id, not by wire-vs-display text comparison');
assert.ok(/restore\(\)/.test(SRC) && /onFail\(rawContent, atts\)/.test(SRC),
    'busy/failure paths must hand the original text and attachments back to the page');
for (const src of [homeSrc, chat]) {
    assert.ok(/mergeAttachments\(pendingAttachments\.value/.test(src),
        'pages must merge restored/picked attachments through the re-validating merge helper');
    assert.ok(/inputWithinBudget\(content, atts\)/.test(src),
        'pages must pre-check the envelope budget BEFORE clearing draft/attachments');
}

// 15-d) P1-2 picker 互斥 + 回填重校验；P1-5 HEIC 拒绝 + 压缩改名 .jpg
assert.ok(/let picking: boolean = false/.test(pickerSrc) && /function beginPick\(/.test(pickerSrc),
    'the picker must mutex concurrent selection flows');
assert.ok(/export function mergeAttachments\(/.test(pickerSrc),
    'a re-validating merge entry must exist (count + total bytes against CURRENT selection)');
assert.ok(/heicUnsupported/.test(pickerSrc) && /isHeicPath/.test(pickerSrc),
    'HEIC that cannot be transcoded must be rejected, never passed through raw');
assert.ok(/function jpegName\(/.test(pickerSrc) && /compressed \? jpegName\(path\)/.test(pickerSrc),
    'compressed JPEG output must be renamed .jpg (name must match content)');

// 15-e) P1-6 技能受理后才消费；纯附件不注入前缀
assert.ok(/rawContent\.length > 0 \? skillPrefix\(\) : ''/.test(SRC),
    'attachment-only messages must not consume the skill as an empty "/id " command');
const sendFn = extractBlock('function sendMessage(');
assert.ok(sendFn.indexOf('loaded.add(id)') < sendFn.indexOf("env.selectedSkill.value = ''"),
    'skill selection must be consumed only after the kernel accepts the input');

// 15-f) P1-7 权限/连接器失败回滚 + 代次守卫 + 离线禁用 + 成功 toast 由结果驱动
assert.ok(/permissionWriteGen/.test(envHook) && /const rollback = \(\): void =>/.test(envHook),
    'permission submit must roll back local state on failure with a generation guard');
assert.ok(/connectorSubmitGen/.test(envHook) && /lastConnectorPrev/.test(envHook),
    'connector submit must guard rapid toggles by generation and roll back to the pre-toggle snapshot');
assert.ok(/:disabled="!connectorSelectable \|\| !deviceOnline"/.test(plusSheetSrc),
    'connector switches must be disabled while the device is offline');
for (const src of [homeSrc, chat]) {
    assert.ok(/env\.toggleConnector\(id, \(on: boolean\): void =>/.test(src),
        'the success toast must be driven by the submit result callback, not fired before the POST');
    assert.ok(/if \(!env\.setPermission\(name\)\) return/.test(src),
        'permission toast must only fire when the change was accepted');
}

// 15-g) P2 词条 ×12 + 死 key 清理 + 新对话清附件
for (const f of langFiles) {
    const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
    for (const k of ['home.run.permDefault', 'home.run.permDefaultDesc', 'home.run.permFull', 'home.run.permFullDesc',
        'home.msg.tooLarge', 'home.msg.permDenied', 'home.plus.heicUnsupported', 'home.plus.unsupported']) {
        assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
    }
    assert.ok(!('home.run.permissionHint' in pack), f + ' must drop the dead permissionHint key');
}
assert.ok(/pendingAttachments\.value = \[\]/.test(extractBlockHome('function onNewChat(')),
    'new chat must clear the welcome-side pending attachments');

// 15-h) P1-4/8 桌面双壳：恢复销账清槽位 + ack 只认本轮 + 无 id 帧尾文本兜底
for (const shell of ['..\\..\\gourd-work\\desktop\\ui\\js\\app-streaming.js', '..\\..\\gourd-ai-tauri\\ui\\js\\app-streaming.js']) {
    const desktop = fs.readFileSync(path.join(__dirname, shell), 'utf8');
    assert.ok(/var isCurrentSend = recovered\.clientMessageId === sess\._pendingClientMessageId/.test(desktop),
        shell + ': recovery echo must distinguish the current send from stale ids');
    assert.ok(/if \(isCurrentSend\) \{\r?\n\s*sess\._pendingClientMessageId = null;/.test(desktop),
        shell + ': recovery must clear the slot and only confirm ack for the current send');
    assert.ok(/_lastSentWireText/.test(desktop),
        shell + ': id-less user frames need the tail-text fallback for old bundled UIs');
}
console.log('PASS  review-fixes: per-session permission codes, foreign-frame rendering, attach restore/mutex/HEIC, id-based rollback, submit rollback guards, desktop recovery settlement');

// 16) vue-i18n esm-bundler 告警治理：旗标必须字面量化（define + transform 双保险），
//     否则 9.x initFeatureFlags() 在 dev 下必打 "You are running the esm-bundler build" 告警。
{
    const viteCfg = fs.readFileSync(path.join(__dirname, '..', 'vite.config.js'), 'utf8');
    assert.ok(/__VUE_I18N_FULL_INSTALL__:\s*true/.test(viteCfg), 'define must keep the vue-i18n full-install flag');
    assert.ok(/__VUE_I18N_LEGACY_API__:\s*false/.test(viteCfg), 'legacy flag must stay false (locale/i18n.ts uses legacy:false)');
    assert.ok(/__VUE_I18N_PROD_DEVTOOLS__:\s*false/.test(viteCfg), 'prod devtools flag must stay false');
    assert.ok(/vueI18nFeatureFlags/.test(viteCfg) && /enforce:\s*'pre'/.test(viteCfg),
        'the transform-layer fallback plugin must stay registered (HBuilderX define coverage is not guaranteed)');

    // 行为级验证：对项目真实安装的 vue-i18n 产物跑插件同款替换，替换后 initFeatureFlags 不得再告警。
    // vm 沙箱剥掉 import/export（该函数只依赖旗标与 console/process），避免 ESM 依赖装填。
    const vm = require('vm');
    const distFile = path.join(__dirname, '..', 'node_modules', 'vue-i18n', 'dist', 'vue-i18n.esm-bundler.js');
    if (fs.existsSync(distFile)) {
        const raw = fs.readFileSync(distFile, 'utf8');
        const start = raw.indexOf('function initFeatureFlags()');
        assert.ok(start !== -1, 'installed vue-i18n must still expose initFeatureFlags (version drift?)');
        let depth = 0, seen = false, end = -1;
        for (let i = raw.indexOf('{', start); i < raw.length; i++) {
            const c = raw[i];
            if (c === '{') { depth++; seen = true; }
            else if (c === '}') { depth--; if (seen && depth === 0) { end = i + 1; break; } }
        }
        const fnSrc = raw.slice(start, end);
        // 与 vite.config.js 的 vueI18nFeatureFlags 插件同款两步：旗标字面量化 + 死函数体置空
        const replaceFlags = (s) => s
            .replace(/\b__VUE_I18N_FULL_INSTALL__\b/g, 'true')
            .replace(/\b__VUE_I18N_LEGACY_API__\b/g, 'false')
            .replace(/\b__VUE_I18N_PROD_DEVTOOLS__\b/g, 'false')
            .replace(/\b__INTLIFY_PROD_DEVTOOLS__\b/g, 'false')
            .replace(/function initFeatureFlags\(\)\s*\{[\s\S]*?\n\}/, 'function initFeatureFlags() {}');
        const runFlags = (src) => {
            const warns = [];
            const sandbox = {
                console: { warn: (m) => warns.push(String(m)) },
                process: { env: { NODE_ENV: 'development' } },
                getGlobalThis: () => sandbox
            };
            vm.createContext(sandbox);
            vm.runInContext(src + '\ninitFeatureFlags();', sandbox);
            return warns;
        };
        assert.ok(runFlags(fnSrc).some((w) => w.includes('esm-bundler build of vue-i18n')),
            'baseline: unreplaced flags must reproduce the warning (otherwise this check is meaningless)');
        // 只字面量化不够：9.1.9 的告警条件是编译期常量 typeof true === 'boolean'，恒触发；
        // 必须连同死函数体一起置空（插件第二步），告警才真正消失。
        const flagsOnly = fnSrc
            .replace(/\b__VUE_I18N_FULL_INSTALL__\b/g, 'true')
            .replace(/\b__VUE_I18N_LEGACY_API__\b/g, 'false')
            .replace(/\b__VUE_I18N_PROD_DEVTOOLS__\b/g, 'false')
            .replace(/\b__INTLIFY_PROD_DEVTOOLS__\b/g, 'false');
        assert.ok(runFlags(flagsOnly).some((w) => w.includes('esm-bundler build of vue-i18n')),
            '9.1.9 quirk: literal flags alone still warn — gutting the dead body is mandatory');
        assert.ok(runFlags(replaceFlags(fnSrc)).length === 0,
            'after literal replacement + dead-body removal initFeatureFlags must not warn');
        assert.ok(/function initFeatureFlags\(\)\s*\{\}/.test(replaceFlags(fnSrc)),
            'the dead-body removal must actually neutralize the function');
    }
}
console.log('PASS  i18n-flags: vue-i18n esm-bundler feature flags literalized (define + pre-transform fallback), warning reproduced then silenced on the installed dist');

// ===== 17) 运行中任务「一直思考中 / 消息不加载」：replay 补帧不得静默截断 =====
// 真因（2026-11 报障）：replayFrom 40 页硬上限（2 万帧）静默截断——长任务流轻松
// 超限（内核注释实测单文件 115k 行）；截断后 rebuildHistory 照样 return true、
// probeRunning 因 running=true 早退，中间整段历史永久缺失，尾部 live 帧只往
// 「思考中」占位上贴。修复三件套：无页数上限（零进展护栏）、失败可感知（返回
// boolean + 退避重试）、快照降级后游标对齐（tail=1 拿全文件 latestSeq）。
(async () => {
    const ts = require('typescript');
    const stripTs = (s) => ts.transpileModule(s, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None }
    }).outputText;
    const stripComments17 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const replayFnSrc = extractBlock('async function replayFrom(');

    // 形态断言：硬上限不得回潮；必须返回成败；零进展护栏必须在
    assert.ok(!/page < 40/.test(replayFnSrc), 'the 40-page hard cap must not regress (silent truncation was the bug)');
    assert.ok(/Promise<boolean>/.test(replayFnSrc), 'replayFrom must report success/failure to its callers');
    assert.ok(/pageMax <= cursorSeq/.test(replayFnSrc), 'a zero-progress guard must replace the page cap');
    const rebuildFn = extractBlock('async function rebuildHistory(');
    // 2026-11-24 首屏重构：rebuildHistory 只拉最新一页（ok 由 replayRoundsPage 的
    // dropped 护栏决定成败），更早轮由 loadEarlierRounds 后台前插。失败仍不得算成功。
    assert.ok(/return ok/.test(rebuildFn), 'a failed first-page replay must not count as a successful history rebuild');
    assert.ok(!/for \(;;\)/.test(rebuildFn), 'rebuildHistory must NOT serially back-page the whole history before first paint (the extreme-slowness bug)');
    const probeRunFn = extractBlock('async function probeRunning(');
    assert.ok(/scheduleResumeRetry\(id\)/.test(probeRunFn), 'probeRunning must schedule backoff retry when the catch-up fails');
    // 探针必须轻量：afterSeq=0 全文件扫描的 After 探针在长流上秒级（卡首屏第二真因）。
    // 先剥注释：函数头注释里引用了旧探针字符串作对比说明。
    const probeCode = stripComments17(probeRunFn);
    assert.ok(/&rounds=1/.test(probeCode) && !/afterSeq=0&limit=1/.test(probeCode),
        'probeRunning must use the bounded rounds=1 probe, not the whole-file After scan');
    // 看门狗：done 帧丢失（旧桌面中转不建 gate 订阅）时周期对账内核 running 态
    assert.ok(/armRunWatchdog\(id\)/.test(probeRunFn), 'probeRunning must arm the run watchdog (lost done frames would pin the spinner forever)');
    const snapFn = stripComments17(extractBlock('async function loadTextSnapshot('));
    assert.ok(/&rounds=1/.test(snapFn), 'the snapshot fallback must align the cursor via a rounds=1 probe (Rounds-mode latestSeq spans the whole file)');
    assert.ok(!/afterSeq=-1&limit=1/.test(snapFn), 'After-mode latestSeq is page-bound — using it for alignment would skip the middle');
    // 终态/删除/设备切换必须撤重试定时器（防泄漏与跨设备补帧）
    for (const fn of ['function markStopped(', 'function failSend(', 'function removeConversation(']) {
        assert.ok(/cancelResumeRetry\(id\)/.test(extractBlock(fn)), fn + ' must cancel pending resume retries');
    }
    // 看门狗与重试同生命周期：cancelResumeRetry 撤看门狗；设备切换清全部看门狗/翻页链
    assert.ok(/cancelRunWatchdog\(id\)/.test(extractBlock('function cancelResumeRetry(')),
        'cancelResumeRetry must also cancel the run watchdog (same lifecycle)');
    assert.ok(/runWatchdogs\.clear\(\)/.test(extractBlock('function resetForDeviceChange(')),
        'device switch must clear all run watchdogs');
    assert.ok(/earlierEpoch \+= 1/.test(extractBlock('function resetForDeviceChange(')),
        'device switch must invalidate in-flight earlier-round paging (stale pages must not prepend into the new device\'s conversations)');
    // 补帧单飞：并发触发（resumed/刷新/看门狗/重试）共享同一 Promise，绝不交错消费游标
    const catchUpSrc = extractBlock('function catchUpFrames(');
    assert.ok(/catchingUp\.get\(id\)/.test(catchUpSrc) && /catchingUp\.set\(id, task\)/.test(catchUpSrc),
        'catch-up must be single-flight (two concurrent replayFrom runs interleave the monotonic cursor and lose frames)');
    assert.ok(/resumeRetryTimers\.clear\(\)/.test(extractBlock('function resetForDeviceChange(')),
        'device switch must clear all resume retry timers');

    // 行为级验证：真实源码 + 可控内核桩（复刻 chat_replay After 分支契约：
    // seq > afterSeq、limit 截断、hasMore = total_after > 本页数）。
    const mkEnv = (totalFrames, opts) => {
        const o = opts || {};
        const consumed = [];
        const requests = [];
        const cursor = { lastSeq: 0, runId: '', startedAt: 0 };
        const buffers = new Map();
        const running = new Set();
        const historyReplay = new Set();
        let failAt = o.failAt || 0; // 第 N 次请求返回非 200（一次性）
        let calls = 0;
        const env = {
            conversationOf: () => ({ id: 's', messages: [] }),
            request: async (_m, _p, query) => {
                calls++;
                requests.push(query);
                if (failAt > 0 && calls === failAt) return { code: 502 };
                const after = Number(/afterSeq=(-?\d+)/.exec(query)[1]);
                const limit = Number(/limit=(\d+)/.exec(query)[1]);
                const events = [];
                let total = 0;
                // 真实流首帧 eventSeq=0（rebuildHistory 用 -1 就是为了含它）
                for (let seq = Math.max(0, after + 1); seq <= totalFrames; seq++) {
                    total++;
                    if (events.length < limit) events.push({ type: 'text', eventSeq: seq, text: 'x' });
                }
                return { code: 200, data: { events, hasMore: total > events.length, running: o.running !== false, runId: 'r1', latestSeq: events.length ? events[events.length - 1].eventSeq : after } };
            },
            kernelOk: (b) => String(b.code) === '200',
            rootOf: () => '',
            consumeFrame: (_id, f) => { consumed.push(f.eventSeq); if (f.eventSeq > cursor.lastSeq) cursor.lastSeq = f.eventSeq; },
            cursorOf: () => cursor,
            fieldString: (obj, k) => (obj && typeof obj[k] === 'string') ? obj[k] : '',
            replayBuffers: buffers,
            running, historyReplay,
            lastAiMessage: () => null,
            closeBatch: () => {}, compactTurn: () => {}, turnStateOf: () => ({}),
            t: (k) => k
        };
        const fn = new Function(...Object.keys(env),
            stripTs(replayFnSrc) + '; return replayFrom;')(...Object.values(env));
        return { fn, consumed, requests, cursor, buffers, running, calls: () => calls };
    };

    // a) 5 万帧长流（101 页）必须全部拉回：旧 40 页上限在 2 万帧处静默截断
    {
        const e = mkEnv(50000);
        const ok = await e.fn('s', -1);
        assert.equal(ok, true, 'a 100+-page stream must complete');
        assert.equal(e.consumed.length, 50001, 'every frame (seq 0..50000) of a long running-task stream must be consumed (old cap stopped at 20000)');
        assert.equal(e.cursor.lastSeq, 50000, 'the cursor must reach the true tail');
        assert.ok(!e.buffers.has('s'), 'the live buffer must be released on completion');
    }
    // b) 中途单页失败：返回 false、游标停在已消费处、缓冲必须撤掉（可重试续拉）
    {
        const e = mkEnv(3000, { failAt: 3 });
        const ok = await e.fn('s', -1);
        assert.equal(ok, false, 'a mid-stream page failure must be reported, not swallowed');
        assert.equal(e.cursor.lastSeq, 999, 'the cursor must stay at the last consumed frame so a retry can resume');
        assert.ok(!e.buffers.has('s'), 'the buffer must be released even on failure');
        const ok2 = await e.fn('s', e.cursor.lastSeq);
        assert.equal(ok2, true, 'the retry must resume from the cursor and complete');
        assert.equal(e.consumed.length, 3001, 'resume must not lose or duplicate frames (seq 0..3000)');
    }
    // c) 零进展病态流（hasMore=true 但整页无有效 seq）：护栏必须退出而不是死循环
    {
        const consumed = [];
        const buffers = new Map();
        const cursor = { lastSeq: 0, runId: '', startedAt: 0 };
        let calls = 0;
        const env = {
            conversationOf: () => ({ id: 's' }),
            request: async () => { calls++; return { code: 200, data: { events: [{ type: 'text' }], hasMore: true, running: true } }; },
            kernelOk: () => true, rootOf: () => '',
            consumeFrame: (_id, f) => consumed.push(f),
            cursorOf: () => cursor, fieldString: () => '',
            replayBuffers: buffers, running: new Set(), historyReplay: new Set(),
            lastAiMessage: () => null, closeBatch: () => {}, compactTurn: () => {}, turnStateOf: () => ({}), t: (k) => k
        };
        const fn = new Function(...Object.keys(env), stripTs(replayFnSrc) + '; return replayFrom;')(...Object.values(env));
        const ok = await fn('s', -1);
        assert.equal(ok, false, 'a zero-progress pathological stream must bail out');
        // 首页 afterSeq=-1 时 pageMax(0)>-1 会再拉一页；第二页 0<=0 零进展即退出
        assert.equal(calls, 2, 'the guard must stop at the first non-advancing page (no infinite loop)');
        assert.ok(!buffers.has('s'), 'the buffer must be released on the guard exit');
    }
    // d) 退避重试节奏：1s×2 封顶 30s、单飞、终态撤单（真实源码 scheduleResumeRetry）
    {
        const schedSrc = extractBlock('function scheduleResumeRetry(');
        const cancelSrc = extractBlock('function cancelResumeRetry(');
        const timers = new Map(); const counts = new Map();
        let now = 0; let nextHandle = 1; const scheduled = [];
        const running = new Set(['s']);
        let replayResult = false; const replayCalls = [];
        const env = {
            resumeRetryTimers: timers, resumeRetryCounts: counts,
            clearTimeout: (h) => { const i = scheduled.findIndex((x) => x.handle === h); if (i >= 0) scheduled.splice(i, 1); },
            setTimeout: (cb, delay) => { const h = nextHandle++; scheduled.push({ handle: h, cb, at: now + delay }); return h; },
            running, conversationOf: () => ({ id: 's' }),
            cursorOf: () => ({ lastSeq: 42 }),
            // 2026-11-24 单飞重构：重试链统一走 catchUpFrames（内部仍是 replayFrom）
            catchUpFrames: async (id) => { replayCalls.push(42); return replayResult; },
            // cancelResumeRetry 现在同时撤运行态看门狗（done 帧丢失自愈链）
            cancelRunWatchdog: () => {}
        };
        const api = new Function(...Object.keys(env),
            stripTs(cancelSrc + '\n' + schedSrc) + '; return { scheduleResumeRetry, cancelResumeRetry };')(...Object.values(env));
        api.scheduleResumeRetry('s');
        api.scheduleResumeRetry('s'); // 单飞：已有定时器等就不叠加
        assert.equal(scheduled.length, 1, 'retry scheduling must be single-flight');
        assert.equal(scheduled[0].at, 1000, 'first retry backs off 1s');
        // 连续失败 7 轮：1,2,4,8,16,30,30（封顶）
        const delays = [1000];
        for (let round = 0; round < 6; round++) {
            const job = scheduled.shift(); now = job.at; job.cb();
            await Promise.resolve(); await Promise.resolve();
            if (scheduled.length) delays.push(scheduled[0].at - now);
        }
        assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000], 'backoff must double and cap at 30s (desktop scheduleStreamingRecovery parity)');
        assert.ok(replayCalls.every((s) => s === 42), 'each retry must resume from the persisted cursor');
        // 成功后不再排；终态撤单后定时器清零
        replayResult = true;
        const job = scheduled.shift(); now = job.at; job.cb();
        await Promise.resolve(); await Promise.resolve();
        assert.equal(scheduled.length, 0, 'a successful catch-up must stop the retry chain');
        api.scheduleResumeRetry('s');
        api.cancelResumeRetry('s');
        assert.equal(scheduled.length, 0, 'terminal states must be able to cancel a pending retry');
    }
    /* ---------------- 22) 产物弹层：真实数据链路（禁止演示数据回流） ---------------- */
    {
        const appRoot = path.join(__dirname, '..');
        // a) 硬编码清单必须彻底消失：ARTIFACTS 常量删了，演示文件名也不许再出现在源码里
        const dataSrc = fs.readFileSync(path.join(appRoot, 'data', 'app-data.ts'), 'utf8');
        assert.ok(!/export const ARTIFACTS/.test(dataSrc), 'the demo ARTIFACTS table must be gone');
        for (const demo of ['信息架构梳理.md', '首页与侧栏结构图.png', 'gwork-mobile-v3.html']) {
            assert.ok(dataSrc.indexOf(demo) === -1, 'demo artifact row must not come back: ' + demo);
        }
        const chatSrc = fs.readFileSync(path.join(appRoot, 'components', 'app-chat', 'app-chat.uvue'), 'utf8');
        assert.ok(!/ARTIFACTS/.test(chatSrc), 'app-chat must not import the demo artifact table');

        // b) 数据源必须是与桌面同源的内核端点，且只读（绝无 undo/reapply/write）
        const hookPath = path.join(appRoot, 'hooks', 'useArtifacts.ts');
        const hookSrc = fs.readFileSync(hookPath, 'utf8');
        assert.ok(/\/web\/chat\/changes\/session/.test(hookSrc),
            'artifacts must come from /web/chat/changes/session (desktop task-monitor parity)');
        // 注释里为了解释「不调写接口」必然会提到路径名，故先剥注释再断言
        const hookCode = stripComments(hookSrc);
        for (const banned of ['changes/undo', 'changes/reapply', 'filer/write']) {
            assert.ok(hookCode.indexOf(banned) === -1, 'mobile artifacts are read-only: ' + banned + ' must not be called');
        }
        assert.ok(/conv\.workspace === DEFAULT_WORKSPACE \? '' : conv\.workspace/.test(hookSrc),
            'the session workspace root must be forwarded as cwd for the ledger query');

        // c) parseArtifacts 纯函数执行：字段判型 + A/M/D + 图片判定 + 坏帧降级
        const tsArt = require('typescript');
        const stripTsArt = (s) => tsArt.transpileModule(s, {
            compilerOptions: { target: tsArt.ScriptTarget.ES2020, module: tsArt.ModuleKind.None }
        }).outputText;
        // 逐个函数块抽出来拼成一个模块源码，再把 export  前缀去掉（TS 转译后会残留
        // exports.x = x，直接给 new Function 会 ReferenceError），最后一次转译成 JS 执行。
        const hookModuleSrc = [
            'const IMAGE_EXTS = ' + hookSrc.match(/const IMAGE_EXTS[^=]*= (\[[^\]]*\])/)[1] + ';',
            extractBlockFrom(hookSrc, 'export function baseNameOf('),
            extractBlockFrom(hookSrc, 'export function extOf('),
            extractBlockFrom(hookSrc, 'function numOf('),
            extractBlockFrom(hookSrc, 'export function kindOf('),
            extractBlockFrom(hookSrc, 'export function parseArtifacts(')
        ].join('\n').replace(/^export /gm, '');
        const hookHelpers = new Function('fieldString', stripTsArt(hookModuleSrc) + '; return { parseArtifacts, baseNameOf, extOf, kindOf };')((obj, key) => { const v = obj == null ? null : obj[key]; return typeof v === 'string' ? v : ''; });
        const parsed = hookHelpers.parseArtifacts({ files: [
            { path: 'docs/信息架构梳理.md', changeType: 'MODIFIED', additions: 12, deletions: 3 },
            { path: 'img\\首页.png', changeType: 'ADDED', binary: true },
            { path: 'a/b.tsx', changeType: 'DELETED', additions: 0, deletions: 9 },
            { path: '' },
            {},
        ] });
        assert.equal(parsed.length, 3, 'pathless rows must be dropped, never rendered as broken cards');
        assert.deepEqual(parsed.map((r) => r.kind), ['M', 'A', 'D'], 'changeType must map to M/A/D badges');
        assert.equal(parsed[0].name, '信息架构梳理.md', 'the card title is the basename');
        assert.equal(parsed[0].ext, 'MD', 'the ext label must be upper-case');
        assert.equal(parsed[1].name, '首页.png', 'both / and \\ separators must be handled (Windows kernel paths)');
        assert.equal(parsed[1].image, true, 'image extensions must switch the card to image mode');
        assert.equal(parsed[2].image, false, 'non-image extensions must stay in doc mode');
        assert.deepEqual(hookHelpers.parseArtifacts({}), [], 'missing files must degrade to empty');
        assert.deepEqual(hookHelpers.parseArtifacts({ files: 'oops' }), [], 'non-array files must degrade to empty');
        assert.deepEqual(hookHelpers.parseArtifacts(null), [], 'a null payload must degrade to empty');
        assert.equal(hookHelpers.parseArtifacts({ files: [{ path: 'x.md', additions: -5, deletions: 'a' }] })[0].additions, 0,
            'bad stats must clamp to 0, never NaN on screen');
        assert.deepEqual(hookHelpers.parseArtifacts({ files: [null, 3] }).length, 0,
            'non-object rows must be skipped without throwing');

        // d) 弹层必须区分四态：loading 不得冒充 empty，error 必须可重试
        const sheetSrc = fs.readFileSync(path.join(appRoot, 'components', 'app-artifact-sheet', 'app-artifact-sheet.uvue'), 'utf8');
        assert.ok(/phase === 'ready' && files\.length > 0/.test(sheetSrc), 'the list must only render on ready+non-empty');
        assert.ok(/phase !== 'error'/.test(sheetSrc) && /chat\.artifacts\.loading/.test(sheetSrc),
            'loading must show its own copy, never the empty-state text (fetching is not "no artifacts")');
        assert.ok(/chat\.artifacts\.retry/.test(sheetSrc) && /emit\('retry'\)/.test(sheetSrc),
            'a failed load must offer an explicit retry, never masquerade as an empty state');
        // 预览必须走读接口，绝无写入
        assert.ok(/\/web\/chat\/filer\/read/.test(sheetSrc), 'text preview must read the real file via filer/read');
        assert.ok(sheetSrc.indexOf('/web/chat/filer/raw') === -1,
            'binary preview must NOT call filer/raw: it streams raw bytes (Java) which cannot cross the JSON string envelope');
        assert.ok(/chat\.artifacts\.binaryHint/.test(sheetSrc),
            'binary artifacts must state plainly that they are desktop-only, never fake a preview');

        // e) 切会话必须失效：上一条会话的产物不得冒充当前会话
        assert.ok(/resetArtifacts\(\)/.test(chatSrc), 'switching conversations must invalidate the artifact list');
        // e2) 一轮任务跑完也要失效（会话 id 没变，账本已变）：只标脏不清屏，避免闪 loading
        assert.ok(/invalidateArtifacts/.test(chatSrc) && /function\s+invalidate|const\s+invalidate/.test(
            fs.readFileSync(hookPath, 'utf8')),
            'a finished run changes the ledger, so the cached list must be invalidated (stale list = invisible new artifacts)');
        assert.ok(/watch\(processing,\s*\(now:\s*boolean,\s*before:\s*boolean\)/.test(chatSrc),
            'the invalidation must be driven by the processing→idle transition, not by a timer');
        assert.ok(/phase\.value\s*=\s*'idle'/.test(fs.readFileSync(hookPath, 'utf8')),
            'invalidate() must drop ready→idle so the next load refetches (a bare reset would flash a loading state)');

        // f) 中转白名单（admin + desktop 设备侧）必须放行只读链路，且**不得**放行写入
        //    与字节流端点。filer/raw 曾是 v1.2 草稿的一部分，但前端从不调用它
        //    （图片走「请在桌面端查看」），放行只会多一个 50MB 的远程读取口子——
        //    这里把「最小权限」锁成断言，防止以后有人凭印象再加回去。
        const adminGo = fs.readFileSync(path.join(appRoot, '..', 'gourd-work-admin', 'controller', 'gwork.go'), 'utf8');
        const linkRs = fs.readFileSync(path.join(appRoot, '..', 'gourd-work', 'desktop', 'src-tauri', 'src', 'device_link.rs'), 'utf8');
        for (const [name, src] of [['gourd-work-admin/controller/gwork.go', adminGo], ['device_link.rs', linkRs]]) {
            for (const p2 of ['/web/chat/changes/session', '/web/chat/filer/read']) {
                assert.ok(src.indexOf('"' + p2 + '"') >= 0, name + ' must allowlist ' + p2);
            }
            // 断言只看**白名单字面量本身**：单测与注释里当然会出现这些路径
            // （负向单测必须写出被拒的路径），拿整个文件做 indexOf 会误报。
            const allowStart = src.indexOf('ALLOWED_PATHS') >= 0 ? src.indexOf('ALLOWED_PATHS')
                : src.indexOf('gworkPathWhitelist');
            const closers = [src.indexOf('];', allowStart), src.indexOf('}', allowStart)]
                .filter((n) => n > allowStart);
            const allowEnd = closers.length > 0 ? Math.min.apply(null, closers) : src.length;
            const allowBlock = src.slice(allowStart, allowEnd);
            for (const p2 of ['/web/chat/changes/undo/file', '/web/chat/changes/reapply/run', '/web/chat/filer/write']) {
                assert.ok(allowBlock.indexOf('"' + p2 + '"') === -1, name + ' must NOT allowlist write path ' + p2);
            }
            // ROOT_SCOPED_PATHS 里也能出现 filer/raw——那是闸门清单，不是放行清单
            assert.ok(allowBlock.indexOf('"/web/chat/filer/raw"') === -1,
                name + ' must NOT allowlist filer/raw: unused by mobile and it streams up to 50MB');
        }

        // f2) 根目录闸门：设备侧必须把「调用方任意指定的 root」收口到已注册项目根。
        //     内核 filer/read 只保证 path 落在 root 之内，root 本身不做注册校验，
        //     所以「放行 filer/read」却不加这道闸门 = 开放远程任意文件读取。
        assert.ok(/const\s+ROOT_SCOPED_PATHS\s*:\s*&\[&str\]\s*=\s*&\[/.test(linkRs),
            'device_link.rs must declare a ROOT_SCOPED_PATHS gate for caller-supplied roots');
        assert.ok(/ROOT_SCOPED_PATHS\.contains\(&req\.path\.as_str\(\)\)/.test(linkRs),
            'the root gate must actually be consulted in the forwarding path');
        assert.ok(/fn\s+root_scope_allowed\s*\(/.test(linkRs) && /load_projects\(\)/.test(linkRs),
            'root_scope_allowed must validate against projects.json (the same source as /web/chat/projects)');
        assert.ok(/root_scope_allowed\(&req\.cwd\)/.test(linkRs),
            'the cwd header can also relocate the kernel root, so it must pass the same gate');
        {
            const at = linkRs.indexOf('ROOT_SCOPED_PATHS: &[&str]');
            const scopedList = linkRs.slice(at, linkRs.indexOf('];', at));
            for (const p2 of ['/web/chat/filer/read', '/web/chat/changes/session']) {
                assert.ok(scopedList.indexOf('"' + p2 + '"') >= 0,
                    p2 + ' resolves paths against a caller-supplied root, so it must be root-scoped');
            }
        }

        // f3) 预览必须带行数上限：Rust 内核 limit=0 会读整个文件，巨型文件会撑爆 16MB WS 帧
        assert.ok(/PREVIEW_LINE_LIMIT\s*:\s*number\s*=\s*\d+/.test(sheetSrc),
            'artifact preview must cap the line count (a huge file would blow the 16MB frame budget)');
        assert.ok(/'&limit='\s*\+\s*PREVIEW_LINE_LIMIT/.test(sheetSrc),
            'the cap must actually be sent to filer/read, not just declared');
        // 内核自判 binary 时不回 content：只看 content 为空会误报「文件为空」
        assert.ok(/payload\['binary'\]\s*===\s*true/.test(sheetSrc),
            'the kernel-decided binary flag must win over an empty content (else an empty-file lie)');
        assert.ok(/chat\.artifacts\.truncated/.test(sheetSrc),
            'a capped preview must tell the user it was truncated, never silently drop text');

        // g) 12 语言文案齐全且 fileMeta 不再有假的 {size}
        for (const f of langFiles) {
            const pack = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8'));
            for (const k of ['chat.artifacts.title', 'chat.artifacts.empty', 'chat.artifacts.fileMeta',
                'chat.artifacts.loading', 'chat.artifacts.loadFailed', 'chat.artifacts.retry', 'chat.artifacts.back',
                'chat.artifacts.summaryFiles', 'chat.artifacts.unknownKind', 'chat.artifacts.previewFailed',
                'chat.artifacts.previewEmpty', 'chat.artifacts.binaryHint', 'chat.artifacts.truncated']) {
                assert.ok(typeof pack[k] === 'string' && pack[k].length > 0, f + ' must define ' + k);
            }
            // 截断文案必须带两个占位符，否则提示里看不出「看到多少 / 一共多少」
            assert.ok(pack['chat.artifacts.truncated'].indexOf('{shown}') >= 0
                && pack['chat.artifacts.truncated'].indexOf('{total}') >= 0,
                f + ' truncated copy must interpolate {shown}/{total}');
            assert.ok(pack['chat.artifacts.fileMeta'].indexOf('{size}') === -1,
                f + ' fileMeta must drop the fake {size} (the kernel never reports file size)');
            assert.ok(!('chat.artifact.detailPending' in pack),
                f + ' must drop the dead "details coming soon" key (detail preview is implemented)');
        }
    }
    console.log('PASS  artifacts: real kernel ledger (changes/session, desktop parity), 4-state sheet with retry, read-only preview, session-scoped invalidation, allowlist synced, 12-lang copy');

    console.log('PASS  replay-resume: no silent 40-page truncation (50k frames pulled), failure reported + cursor-safe retry, zero-progress guard, snapshot cursor alignment, backoff 1s..30s single-flight');

    /* ===== 18) rounds replay + attachment thumbnails + data:image (2026-11) =====
       用户报障「已完成会话历史加载十几分钟」+「插画展示有问题」的双根因回归锁：
       a) rebuildHistory 必须走 rounds 合帧回放，绝不允许退回 afterSeq 逐帧全量；
       b) user 帧 imagePaths 必须经 attachment/meta 升级 dataUrl 缩略图；
       c) md 图片校验必须放行 data:image/*（PC _sanitizeUrlAllowed 同口径）。 */
    {
        const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
        const parseSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'markdown-parse.uts'), 'utf8');
        const bubbleSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue'), 'utf8');

        // a) 历史加载：rounds 合帧分页（afterSeq 逐帧回放是十几分钟卡顿真因）
        assert.ok(/async function replayRoundsPage/.test(hookSrc),
            'history replay must use a rounds-paginated loader (kernel coalesced projection)');
        assert.ok(/'&rounds=' \+ HISTORY_PAGE_ROUNDS/.test(hookSrc),
            'the rounds loader must send rounds=N (desktop app-history.js parity)');
        assert.ok(/'&beforeSeq=' \+ beforeSeq\.toString\(\)/.test(hookSrc),
            'earlier-rounds pagination must advance via beforeSeq, not re-pull from the top');
        const rbAt = hookSrc.indexOf('async function rebuildHistory');
        const rbSlice = hookSrc.slice(rbAt, hookSrc.indexOf('async function loadTextSnapshot'));
        assert.ok(/replayRoundsPage\(id\)/.test(rbSlice),
            'rebuildHistory must call replayRoundsPage — afterSeq=-1 full replay is the slow-load root cause');
        assert.ok(!/replayFrom\(id, -1\)/.test(rbSlice),
            'rebuildHistory must NOT fall back to afterSeq=-1 frame-for-frame replay (O(pages × full-file rescans))');
        // 零进展护栏仍在（rounds 翻页不能死循环）。2026-11-24 重构后更早轮翻页
        // 独立成 loadEarlierRounds：退出前收口头部悬空占位（sealEarlierHead），
        // 不再是 return false（首页已上屏，翻页失败只保留已展示部分）。
        const earlierFn = extractBlockFrom(hookSrc, 'async function loadEarlierRounds(');
        assert.ok(/first <= 0\) \{ sealEarlierHead\(id, epoch\); return \}/.test(earlierFn)
            && /first >= beforeSeq\) \{ sealEarlierHead\(id, epoch\); return \}/.test(earlierFn),
            'the earlier-rounds pager must keep the zero-progress guard');
        // 首屏一页即上屏：更早轮 fire-and-forget，绝不阻塞 probeRunning 接流
        const loadInnerFn = extractBlockFrom(hookSrc, 'async function loadMessagesInner(');
        assert.ok(loadInnerFn.indexOf('probeRunning(id)') < loadInnerFn.indexOf('loadEarlierRounds(id)'),
            'live-stream attach (probeRunning) must happen BEFORE earlier-rounds back-paging (the frozen-running-task bug)');
        // 更早轮前插绝不走真实会话的单调游标（影子会话渲染），翻页代号防迟到页串会话
        assert.ok(/epoch !== earlierEpoch/.test(earlierFn),
            'stale earlier pages must be discarded via the paging epoch (rebuild/device-switch invalidates)');
        assert.ok(/conversations\.value\.push\(shadow\)/.test(extractBlockFrom(hookSrc, 'function prependRoundsPage(')),
            'earlier pages must render in a shadow conversation (the real monotonic cursor would swallow every earlier frame)');

        // b) 附件缩略图：imagePaths → /web/chat/attachment/meta → dataUrl
        assert.ok(/fetchAttachmentDataUrls/.test(hookSrc) && /\/web\/chat\/attachment\/meta/.test(hookSrc),
            'user-frame imagePaths must be upgraded via the kernel attachment/meta endpoint (desktop renderUserAttachmentPaths parity)');
        // 2026-11-24 review 修复：consumeFrame 增加 wireId（对外身份）参数——
        // 影子会话前插时附件 meta 请求必须打真实会话 id（内核按会话目录解析），
        // 升级入口第一参是 realId（缺省=sessionId），不再是裸 sessionId。
        assert.ok(/upgradeUserAttachments\(realId, rootOf\(conv\), userMsg, attachImgPaths\)/.test(hookSrc),
            'the new-message path must kick off the thumbnail upgrade (with the wire session id)');
        assert.ok(/const realId: string = wireId != null && wireId\.length > 0 \? wireId : sessionId/.test(hookSrc),
            'consumeFrame must resolve the wire id (shadow rendering keeps cursor isolation but attachment/steer keys use the real session)');
        assert.ok(/consumeFrame\(shadowId, sorted\[i\], id\)/.test(hookSrc),
            'shadow prepend must pass the real session id as wireId (meta requests to id#earlier always fail and storm the link)');
        assert.ok(/imageUrls: string\[\]/.test(fs.readFileSync(path.join(__dirname, '..', 'data', 'app-data.ts'), 'utf8')),
            'ChatMessage must carry imageUrls (placeholder text alone hides the illustration)');
        assert.ok(/__attach-img/.test(bubbleSrc) && /uni\.previewImage\(\{ urls: props\.message\.imageUrls/.test(bubbleSrc),
            'the bubble must render a tappable thumbnail grid and open the system preview (props.message — bare `message` is undefined in script setup)');
        assert.ok(!/uni\.previewImage\(\{ urls: message\.imageUrls/.test(bubbleSrc),
            'previewImage must not reference the bare `message` identifier (runtime crash on tap)');

        // d) 【codereview P0】rounds 倒拉翻页必须缓冲到翻完再统一消费：
        //    consumeFrame 去重游标单调只进，逐页即时消费会让第 2 页起（更早轮）
        //    全部被 seq <= lastSeq 吞掉——历史只剩最新 10 轮还谎报「加载完成」。
        const rpAt = hookSrc.indexOf('async function replayRoundsPage');
        const rpSlice = hookSrc.slice(rpAt, hookSrc.indexOf('async function scheduleResumeRetry') >= 0 ? hookSrc.indexOf('/** 运行态续流的退避重试') : hookSrc.length);
        assert.ok(/只进缓冲不消费/.test(hookSrc),
            'rounds pages must accumulate into replayBuffers, not consume per-page (monotonic cursor would swallow every earlier page)');
        const rpBody = hookSrc.slice(rpAt, hookSrc.indexOf('replayBuffers.delete(id)', rpAt));
        assert.ok(!/consumeFrame\(id, frames\[i\]\)/.test(rpBody),
            'the page loop must NOT call consumeFrame directly — buffer and sort-then-consume at the end (P0 regression lock)');
        assert.ok(/for \(let i = 0; i < buffered\.length; i\+\+\) consumeFrame\(id, buffered\[i\]\)/.test(rpBody),
            'the sorted full-buffer consume loop must remain the single consumption path');
        // 游标对齐必须在统一消费之后（否则 latestSeq 上抬先于渲染，去重再吞一遍）。
        // dropped 护栏版对齐条件带 !dropped 前缀（溢出时不上抬游标）。
        const alignIdx = rpBody.indexOf('latest > cursor.lastSeq)');
        const consumeIdx = rpBody.indexOf('for (let i = 0; i < buffered.length; i++) consumeFrame');
        assert.ok(alignIdx > consumeIdx && alignIdx > 0 && consumeIdx > 0,
            'cursor latestSeq alignment must happen AFTER the sorted consume loop');
        // d2) 【codereview 补】缓冲溢出丢帧不能谎报拉全：倒拉页序下 shift 掉的是
        //     最早页的最旧帧（从未消费），而游标会上抬到全文件 latestSeq——若照常
        //     return true，probeRunning 续流永久跳过缺的那段（静默丢历史）。
        assert.ok(/buffer\.shift\(\); dropped = true/.test(rpBody),
            'the rounds buffer overflow guard must flag dropped frames (oldest pages are lost, never consumed)');
        assert.ok(/return !dropped/.test(rpBody),
            'an overflow-truncated rounds replay must return false so loadMessagesInner falls back to the text snapshot — never claim a full load');

        // c) md 图片白名单：data:image/* 放行（源码断言；行为级验证在 markdown 节已有 img 渲染断言）
        assert.ok(/function mdSafeImageSrc/.test(parseSrc),
            'image src validation must have its own allow-list (data:image/* allowed)');
        assert.ok(/mdSafeImageSrc\(src\)/.test(parseSrc) && !/mdSafeHref\(src\)/.test(parseSrc),
            'the img branch must call mdSafeImageSrc, not the link allow-list that blanket-rejects data:');
        assert.ok(/data:image\/'/.test(parseSrc.replace(/\\\//g, '/')),
            'data:image/ must be explicitly allowed (inline thumbnails/illustrations)');
        assert.ok(/indexOf\('data:'\) === 0\) return lower\.indexOf\('data:image\/'\) === 0/.test(parseSrc.replace(/\r/g, '')),
            'only data:image/* may pass; other data: forms stay rejected');
    }
    console.log('PASS  rounds-replay-attachments: history loads via coalesced rounds paging (no afterSeq full replay), imagePaths→meta thumbnails render tappable, data:image/* allowed for md images');

    /* ===== 19) 插话 = 用户消息，不是工具/notice 行（2026-11 用户报障「插话展示成了工具形式」） =====
       PC appendSteerNote 的契约：steer_applied 以右对齐用户气泡呈现（+「插话」徽标 +
       附件缩略图），仅多一枚身份徽标区别于普通发送。移动端旧实现落 notice 块挂进 AI
       轨迹（工具行形态）——视觉像内核事件，不像用户说的话。回归锁：
       a) steer_applied 必须建 role='user' 的消息行（绝不再进 notice 分支）；
       b) steer 幂等键必须带会话前缀且 rebuildHistory 清除（否则刷新后插话气泡消失）；
       c) 徽标必须存在且复用 chat.segment.steer 词条（12 语言已齐，不新增键）；
       d) steer_dropped/cancelled 不得建用户气泡（没生效的事件，PC 只 toast）。 */
    {
        const hookSrc = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
        const bubbleSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue'), 'utf8');
        const dataSrc = fs.readFileSync(path.join(__dirname, '..', 'data', 'app-data.ts'), 'utf8');
        const zhSrc = fs.readFileSync(path.join(__dirname, '..', 'locale', 'zh-Hans.json'), 'utf8');

        // a) 专用分支建用户行：steer_applied 不得再落 notice 工具行
        assert.ok(/kind === 'steer_applied' \|\| kind === 'steer_dropped' \|\| kind === 'steer_cancelled'/.test(hookSrc),
            'steer frames must be intercepted in a dedicated branch BEFORE the notice branch');
        const noticeAt = hookSrc.indexOf('const noticeKind: boolean');
        const steerAt = hookSrc.indexOf("kind === 'steer_applied'");
        assert.ok(steerAt >= 0 && noticeAt > steerAt,
            'the steer branch must precede the notice branch (notice fallback would swallow steer frames)');
        assert.ok(!/noticeKind: boolean = kind === 'command' \|\| kind === 'rewind' \|\| kind === 'steer_applied'/.test(hookSrc),
            'steer_applied must NOT be part of noticeKind anymore (tool-row form is the reported bug)');
        assert.ok(/emptyChatMessage\('steer-' \+ steerId, 'user', displayText, 'done', false, true\)/.test(hookSrc),
            'steer_applied must create a user-role message with steer=true (PC appendSteerNote parity)');
        // 附件同链路：插话携带的 imagePaths 也走 meta 缩略图升级
        assert.ok(/upgradeUserAttachments\(realId, rootOf\(conv\), steerMsg, sImgPaths\)/.test(hookSrc),
            'steer attachments must go through the same meta thumbnail upgrade as user frames (wire session id)');
        assert.ok(/steerKey\(realId, steerId\)/.test(hookSrc),
            'steer idempotency keys must use the wire session id (shadow prepend would otherwise never reuse the real-session registration)');
        // d) dropped/cancelled 只登记键、不建用户气泡
        const steerBranch = hookSrc.slice(steerAt, noticeAt);
        assert.ok(/if \(kind !== 'steer_applied'\) return/.test(steerBranch),
            'only steer_applied creates the user bubble; dropped/cancelled stop at idempotent registration');
        // e) 轮次边界收口（2026-11 codereview 补）：PC appendSteerNote 强制插话气泡成为
        // 新旧正文分界（settleSteerTurnBoundary + ensureAssistantBubble）。移动端若只 push
        // 用户行，插话后的正文帧经 lastAiMessage 仍定位插话上方的旧气泡 → 正文全部写进
        // 插话前的气泡，顺序颠倒。回归锁：push 后 flush 文本缓冲 + 判空删/收口旧尾条 +
        // resetTurnState，缺一即回归。
        const pushAt = steerBranch.indexOf('conv.messages.push(steerMsg)');
        assert.ok(pushAt >= 0 && steerBranch.indexOf('flushTextBuf(conv.id)') > pushAt,
            'the text buffer must be flushed AFTER the steer row is pushed (pending deltas belong to the pre-steer turn and must land in the old bubble, not the post-steer one)');
        assert.ok(/flushTextBuf\(conv\.id\)/.test(steerBranch),
            'pre-steer pending deltas must be flushed before the empty-tail verdict — otherwise a tail with in-flight text looks empty and gets dropped (text loss)');
        assert.ok(/tailAi\.text\.length === 0 && tailAi\.blocks\.length === 0/.test(steerBranch)
            && /conv\.messages\.splice\(aiIdx, 1\)/.test(steerBranch),
            'an empty AI tail (placeholder before any output) must be removed by id, not collapsed into an empty done bubble');
        assert.ok(/finishProcessingTail\(conv, 0\)/.test(steerBranch),
            'a non-empty AI tail must be closed out (done) at the steer boundary so later frames build a new bubble BELOW the steer row');
        assert.ok(steerBranch.indexOf('resetTurnState(sessionId)') > steerBranch.indexOf('finishProcessingTail(conv, 0)'),
            'turn state must be reset after the tail is settled — later frames start a fresh bubble after the steer row (PC parity: ensureAssistantBubble)');

        // b) 幂等键带会话前缀 + rebuildHistory 清除（刷新后插话必须能还原）
        assert.ok(/function steerKey\(sessionId: string, steerId: string\)/.test(hookSrc),
            'the steer idempotency key must be session-scoped (global set survives session rebuild)');
        assert.ok(/clearSteerResolved\(id\)/.test(hookSrc),
            'rebuildHistory must clear the session\'s steer keys — replay must be able to restore steer bubbles after refresh');
        assert.ok(/steerResolved\.has\(key\)/.test(hookSrc) && !/steerResolved\.has\(steerId\)/.test(hookSrc),
            'membership checks must use the session-scoped composite key');

        // c) 徽标：模板 + 样式 + 复用现成词条
        assert.ok(/v-if="message\.steer"/.test(bubbleSrc) && /__steer-badge/.test(bubbleSrc),
            'the bubble must render the steer badge on user messages (chat.segment.steer label)');
        assert.ok(/steer: boolean/.test(dataSrc),
            'ChatMessage must carry the steer flag (notice rows cannot express the badge)');
        assert.ok(/"chat\.segment\.steer"/.test(zhSrc),
            'chat.segment.steer must exist (reused from the 12-language set — no new keys)');
    }
    console.log('PASS  steer-user-message: steer_applied renders as a user bubble with badge + attachments (no tool/notice row), session-scoped idempotency cleared on rebuild, dropped/cancelled stay non-bubble');

    /* ---------------- 26) Qoder 层级缩进 + 思考指示器退役（2026-11 用户拍板，PC ⑳ 同口径） ----------------
       PC app.css ⑳：盖子第一列、成员右移 26px、盖子左缘 1px 引导线；
       PC app-message.js：showThinking/showInlineThinking no-op（防跳动）。
       移动端 UCSS 无伪元素/:not()，等价实现钉死如下，防「改了但看起来没改」回归。 */
    {
        const b = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue'), 'utf8');
        const stylePart = b.slice(b.indexOf('<style'));
        // a) 成员整体右移一列：wrapper margin-left 26px（PC ⑳ padding-left 26px 同口径），
        //    写在 wrapper 上而非行头 padding——行内前导件/文本列几何与限高估算零改动
        assert.ok(/&__member \{[\s\S]{0,80}margin-left: 26px/.test(stylePart),
            'batch members must shift one column right via wrapper margin-left 26px (PC layer-20 parity)');
        assert.ok(/function memberWrapClass\(item: ChatBlock\): string/.test(b)
            && /item\.interact\.length === 0 \? 'app-chat-bubble__member' : ''/.test(b),
            'HITL/question/resolved interact cards must be exempt from the indent (PC :not(.hitl-pending) parity, data-driven for UCSS)');
        assert.ok((b.match(/:class="memberWrapClass\(item\)"/g) || []).length === 2,
            'both member loops (windowed + batched-flat group) must apply the indent class');
        // b) 引导线：真 view 画线（UCSS 无 ::before），absolute top:0/bottom:0 随成员伸缩；
        //    两条路径（滚动窗 group / 平铺 group）都有，且只在有真实成员时渲染
        assert.ok((b.match(/class="app-chat-bubble__group-guide"/g) || []).length === 2,
            'both group paths must paint the guide line');
        assert.ok(/&__group-guide \{[\s\S]{0,220}position: absolute;[\s\S]{0,120}left: 7px;[\s\S]{0,80}top: 0;[\s\S]{0,80}bottom: 0;[\s\S]{0,80}width: 1px;/.test(stylePart),
            'the guide must be a 1px absolute rail at the chevron column (left 7px), auto-stretching with members');
        assert.ok(/v-if="seg\.windowed && seg\.members\.length > 0" class="app-chat-bubble__group"/.test(b)
            && /v-if="seg\.head != null && seg\.members\.length > 0" class="app-chat-bubble__group"/.test(b),
            'guide groups must render only for batches with real members (collapsed/empty batches leave no rail)');
        assert.ok(/seg\.windowed = seg\.members\.length > 0 && \(est > WINDOW_MAX_PX \|\| seg\.members\.length >= WINDOW_MIN_ROWS\)/.test(b),
            'empty batches must not open a scroll window (no 2px ghost gap)');
        // c) 平铺防重复：进 group 的批次段在通用循环出空数组，常驻行段原样平铺
        assert.ok(/function flatMembers\(seg: BubbleSegment\): ChatBlock\[\]/.test(b)
            && /if \(seg\.head != null && seg\.members\.length > 0\) return \[\]/.test(b)
            && /v-for="item in flatMembers\(seg\)"/.test(b),
            'the resident flat loop must not re-render members already shown in the batch group');
        // d) 思考指示器退役：pending 行/spinner/「思考中」文案全部不再渲染（PC no-op 同口径）
        assert.ok(!/app-chat-bubble__pending/.test(b) && !/app-chat-bubble__spinner/.test(b)
            && !/t\('chat\.thinking'\)/.test(b) && !/<loading/.test(b),
            'the bouncing thinking indicator must stay retired (PC showThinking no-op parity)');
        // e) 首帧前占位：仅 processing 且零可见内容时渲染定高 22px 空行，首帧即让位
        assert.ok(/const showIdleSlot: ComputedRef<boolean>/.test(b)
            && /msg\.status === 'processing'/.test(b)
            && /msg\.text\.length === 0 && msg\.blocks\.length === 0 && msg\.summary\.length === 0/.test(b),
            'the idle slot must appear only before the first visible content of a processing turn');
        assert.ok(/v-if="showIdleSlot" class="app-chat-bubble__idle-slot"/.test(b)
            && /&__idle-slot \{[\s\S]{0,60}height: 22px/.test(stylePart),
            'the idle slot must be a fixed 22px row (same height as a process row head, no spinner/text)');
        // f) 三层运行反馈保留：停止按钮（composer processing）/ 盖子秒级计时 / 行状态点
        assert.ok(/function batchLabel\(item: ChatBlock\): string/.test(b) && /formatBatchElapsed\(item\.startedAt, nowTick\.value\)/.test(b),
            'the batch lid must keep its per-second elapsed label (running feedback layer 2)');
        assert.ok(/function rowDotClass\(item: ChatBlock\): string/.test(b),
            'process rows must keep their status dots (running feedback layer 3)');
        const composerSrc = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-composer', 'app-composer.uvue'), 'utf8');
        assert.ok(/v-if="processing"/.test(composerSrc) && /circ--stop/.test(composerSrc),
            'the composer stop button must stay (running feedback layer 1)');
        // g) thinking 状态字段保留（正文分支守卫依赖），hook 侧 reason_start 相位推进不动
        const hookSrc26 = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
        assert.ok(/if \(msg != null\) msg\.thinking = true/.test(hookSrc26),
            'reason_start must still flip the thinking phase flag (final-text guards depend on it)');
        assert.ok((b.match(/!message\.thinking/g) || []).length >= 3,
            'the final-text branches must keep their !message.thinking guards');
    }
    console.log('PASS  qoder-indent-nojump(mobile): members indented 26px with 1px guide rail (both windowed/flat paths, interact cards exempt), thinking indicator retired with fixed idle slot, three-layer running feedback intact');

    /* ---------------- 27) 变更卡钉底 + 被动快照不切批次（2026-11 用户报障
       「文件变更卡怎么跑到这里了，之前不是在正文最后嘛；思考显示顺序都乱了，也没折叠」）
       PC 同口径：insertBeforeActions 越过 fch-host + compact tail 三档；
       移动端等价实现 = sinkChangesBlocks 钉底 + applyFileChanges 不动批次/相位。 */
    {
        const hook27 = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'useConversations.ts'), 'utf8');
        // a) 钉底函数存在且幂等（已在末尾零写入），applyFileChanges 与帧消费入口都接线
        assert.ok(/function sinkChangesBlocks\(msg: ChatMessage\): void/.test(hook27),
            'sinkChangesBlocks must exist (changes cards pinned to the end of the process area)');
        const sinkFn = stripComments(extractBlock('function sinkChangesBlocks('));
        assert.ok(/if \(tailOk\) return/.test(sinkFn) && /msg\.blocks = keep\.concat\(cards\)/.test(sinkFn),
            'the sink must be idempotent: zero writes when cards already trail (no per-frame reactive array rebuild)');
        const apply27 = stripComments(extractBlock('function applyFileChanges('));
        assert.ok(/sinkChangesBlocks\(msg\)/.test(apply27),
            'applyFileChanges must sink the card after upsert');
        assert.ok(/const sinkTail: ChatMessage \| null = lastAiMessage\(conv\)/.test(hook27)
            && /if \(sinkTail != null\) sinkChangesBlocks\(sinkTail!\)/.test(hook27),
            'consumeFrame must re-sink on every frame (later frames must not push blocks below the card)');
        // b) 被动快照不得切批次/清思考相位（PC onWebChunk file_changes 短路同口径）
        assert.ok(!/closeBatch\(/.test(apply27),
            'a passive file_changes snapshot must NOT close the running batch (mid-stream snapshots were cutting batches in half)');
        assert.ok(!/msg\.thinking = false/.test(apply27),
            'a passive snapshot must NOT clear the thinking phase flag');
        // c) 卡片豁免批次归属：不随成员折叠隐藏、不被 26px 缩进（PC KEEP_VISIBLE 白名单同口径）
        assert.ok(/block\.batchId = ''/.test(apply27) && /block\.batchCollapsed = false/.test(apply27),
            'the changes card must not belong to any batch (resident segment, never hidden by collapse nor indented)');
        // d) 行为级：sinkChangesBlocks 真跑——卡在中间 → 下沉末尾；已在末尾 → 零写入；多卡保序
        const sinkJs = extractBlock('function sinkChangesBlocks(')
            .replace(/\(\s*msg:\s*ChatMessage\s*\)\s*:\s*void/g, '(msg)')
            .replace(/\(\s*item:\s*ChatBlock\s*\)\s*:\s*void/g, '(item)')
            .replace(/:\s*ChatBlock\[\]/g, '').replace(/:\s*boolean/g, '').replace(/:\s*number/g, '');
        const sink = new Function(sinkJs + '; return sinkChangesBlocks;')();
        const card = (id) => ({ id, args: 'fileChanges' });
        const row = (id) => ({ id, args: '' });
        const c1 = card('c1'), r1 = row('r1'), r2 = row('r2'), c2 = card('c2');
        const msgA = { blocks: [r1, c1, r2] };
        sink(msgA);
        assert.deepEqual(msgA.blocks.map((b) => b.id), ['r1', 'r2', 'c1'],
            'a mid-list card must sink below all process rows');
        const before = msgA.blocks;
        sink(msgA);
        assert.ok(msgA.blocks === before, 'already-trailing cards must cause zero writes (same array reference)');
        const msgB = { blocks: [c1, r1, c2, r2] };
        sink(msgB);
        assert.deepEqual(msgB.blocks.map((b) => b.id), ['r1', 'r2', 'c1', 'c2'],
            'multiple cards must sink together preserving their relative order');
        const msgC = { blocks: [r1, r2] };
        const beforeC = msgC.blocks;
        sink(msgC);
        assert.ok(msgC.blocks === beforeC, 'no cards = no-op');
        // e) 【code review 补洞】唯一建块漏斗 ensureBlock 也必须 sink：
        //    入口 sink 只在本帧开始收敛一次，本帧内新建的 HITL/问答/notice 块
        //    （非过程帧，无后续帧纠正——挂起期可能长时间无帧）不得排到卡片之后。
        const ensureFn = stripComments(extractBlock('function ensureBlock('));
        assert.ok(/sinkChangesBlocks\(msg\)/.test(ensureFn),
            'ensureBlock must re-sink after push (in-frame window: HITL/qa blocks created while a card already trails must not land below it)');
        assert.ok(/const fresh: ChatBlock = msg\.blocks\[msg\.blocks\.length - 1\]/.test(ensureFn)
            && /return fresh/.test(ensureFn),
            'ensureBlock must capture the pushed proxy BEFORE the sink may replace the array (stale tail read would return undefined)');
        // f) 【模板层钉底 · 2026-11 用户「刚刚修改了下，还是有问题」】上一版只把卡
        //    sink 到 blocks 数组末尾，误把「数组末尾」当「消息流末尾」：模板里
        //    showProcess 过程区恒在最终正文 message.text 之前，卡片仍在正文上方。
        //    钉死：过程区数据必须滤掉卡片，卡片由尾部循环在最终正文之后/meta 之前渲染。
        const bubble27 = fs.readFileSync(path.join(__dirname, '..', 'components', 'app-chat-bubble', 'app-chat-bubble.uvue'), 'utf8');
        assert.ok(/const changesBlocks: ComputedRef<ChatBlock\[\]> = computed/.test(bubble27)
            && /item\.args === 'fileChanges'/.test(bubble27),
            'bubble must expose a dedicated changesBlocks list (cards are not process rows)');
        assert.ok(/props\.message\.blocks\.filter\(\(item: ChatBlock\): boolean => item\.args !== 'fileChanges'\)/.test(bubble27),
            'visibleBlocks/segments must exclude changes cards (no batch-window/indent pollution)');
        const tailCard = bubble27.indexOf('<view v-for="item in changesBlocks"');
        const finalText = bubble27.indexOf('<app-md-text v-if="!message.thinking');
        const metaTail = bubble27.indexOf('class="app-chat-bubble__meta"');
        assert.ok(tailCard >= 0 && finalText >= 0 && metaTail >= 0, 'tail card / final text / meta anchors must exist');
        assert.ok(finalText < tailCard && tailCard < metaTail,
            'changes cards must render AFTER the final text and BEFORE meta (true content-stream tail)');
        // g) 【终态仍显示正在执行中】file_changes 是比 done 更靠后的最后信号；done 后
        //    迟到过程帧可能重开 loading 批次盖子且无人再收口。只在终态/非运行/非回放
        //    收敛残留 loading 头，绝不在流式中切批次（上一轮已实证的反向回归）。
        assert.ok(/function settleTerminalBatchHeads\(/.test(hook27),
            'a terminal-settlement helper must exist (late file_changes is the last authoritative signal)');
        const settleFn = stripComments(extractBlock('function settleTerminalBatchHeads('));
        assert.ok(/historyReplay\.has\(conv\.id\) \|\| running\.has\(conv\.id\)/.test(settleFn)
            && /msg\.status !== 'done' && msg\.status !== 'stopped'/.test(settleFn),
            'settlement must be gated to terminal, non-running, non-replay messages only');
        assert.ok(/head\.status !== 'loading'/.test(settleFn) && /head\.startedAt = 0/.test(settleFn),
            'residual running batch heads must be closed and their ticker start cleared');
        assert.ok(/settleTerminalBatchHeads\(conv, msg\)/.test(apply27),
            'applyFileChanges must invoke terminal settlement after sinking the card');
    }
    console.log('PASS  changes-card-pinned(mobile): passive snapshots never cut batches/thinking, cards sink to the process-area tail and render after final text, batch membership exempt, terminal running heads settled');
    console.log('ALL MOBILE CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });

/* 从 useRunEnv.ts / home/index.uvue 截函数块（与 extractBlock 同算法，不同源文件） */
function extractBlockFrom(src, needle) {
    const start = src.indexOf(needle);
    if (start === -1) throw new Error('not found: ' + needle);
    let depth = 0, seen = false;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        const c = src[i];
        if (c === '{') { depth++; seen = true; }
        else if (c === '}') { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('unbalanced braces: ' + needle);
}
function extractBlockEnv(needle) { return extractBlockFrom(envHook, needle); }
function extractBlockHome(needle) { return extractBlockFrom(homeSrc, needle); }
