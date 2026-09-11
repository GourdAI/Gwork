/* ===== app-base.js ===== */
/* DOM引用 + 状态 + 工具函数（最先加载，无依赖） */

/* ===== DOM ===== */
var welcomeView = document.getElementById('welcomeView');
var chatView = document.getElementById('chatView');
var messagesWrap = document.getElementById('messagesWrap');
var welcomeInput = document.getElementById('welcomeInput');
var welcomeSendBtn = document.getElementById('welcomeSendBtn');
var chatInput = document.getElementById('chatInput');
var chatSendBtn = document.getElementById('chatSendBtn');
var newChatBtn = document.getElementById('newChatBtn');
var historyList = document.getElementById('historyList');

/* ===== Constants ===== */
var DOTS_HTML = '<span class="thinking-dots"><span></span><span></span><span></span></span>';

/* ===== Per-Session State ===== */
function SessionState(sessionId) {
    this.sessionId = sessionId;
    this.container = $('<div>')[0];
    $(this.container).addClass('messages-inner');
    $(this.container).hide();
    $(messagesWrap).append(this.container);
    this.eventSource = null;
    // 会话所属根必须随会话保存；后台补发/队列发送不能读取当前活动会话的全局工作区。
    this.projectRoot = '';
    this.isStreaming = false;
    this.currentBubbleEl = null;
    this.reasonBuffer = '';
    this.thinkingBlockEl = null;
    this.thinkingBodyMdEl = null;
    this.thinkingBodyWrapEl = null;
    this.thinkingBuffer = '';
    this.pendingToolCard = null;
    this.pendingToolStarted = false;
    this.toolCardsById = {};
    this.completedActionIds = {};
    this.approvedToolCard = null;
    this.thinkingEl = null;
    this.inlineThinkingEl = null;
    this.silenceTimer = null;
    this.contentRafId = null;
    this.reasonRafId = null;
    this.thinkingTimerId = null;
    this.thinkingStartTime = null;
    this.inlineThinkingTimerId = null;
    this.inlineThinkingStartTime = null;
    this.thinkingBlockTimerId = null;
    this.thinkingBlockStartTime = null;
    // 当前生命周期相位（waiting/thinking/text/tool/hitl/retry/done），
    // 由后端 WebChunk.phase 驱动，旧历史帧降级按 type 推断。见 app-streaming.js 的相位状态机。
    this.phase = null;
    this.thinkingUserScrolledUp = false;  // 思考区用户主动向上滚动标记
    // 最近一次 context_size 快照：上下文指示器是全局单例 DOM，靠它按会话回填，使切会话不丢失用量/缓存指标
    this.lastContextChunk = null;
    // 最后一次被激活的时间戳，供容器 LRU 淘汰排序（见 evictInactiveSessions / pruneSessionDrafts）
    this.lastActiveAt = 0;
    // 未发送的输入草稿：输入框/附件区是全局单例 DOM，必须按会话存取（见 saveSessionDraft）
    this.draft = '';
    this.draftFiles = null;   // null=无草稿附件；数组=该会话暂存的附件（持有 File/dataUrl，需按 LRU 释放）

    // 断线恢复状态：lastEventSeq 是已应用的稳定游标，恢复期间实时帧先进入 _gateBuffer。
    this.lastEventSeq = 0;
    this._pendingClientMessageId = null;
    this._recovering = false;
    this._recoverGeneration = 0;
    this._resumePromise = null;
    this._recoverRetryTimer = null;
    this._recoverRetryCount = 0;
    this._gateBuffering = false;
    this._gateBuffer = [];
    this._requestStartSeq = null;
    this._awaitingSendAck = false;
    this._sendAckConfirmed = false;

    // 即时插话（steer）状态：activeRunId 仅追踪主代理运行，不能被子代理 chunk 覆盖。
    this.currentRunId = null;
    this.activeRunId = null;
    this.steerPending = {};   // steerId -> {text, runId, createdAt, state}
    this.steerResolved = {};  // 已收到 applied/dropped/cancelled 的短期幂等集合
    this._steerSending = false;

    this.userMsgCounter = 0;
}

var sessionMap = {};
var activeSessionId = null;

/* ===== Global State ===== */
/* 应用模式：'chat'（默认，会话存安装目录全局区）| 'code'（会话存所选项目） */
var appMode = 'chat';
window.appMode = appMode;
/* Code 模式当前所选项目根目录绝对路径（chat 模式为空） */
window.currentProjectRoot = '';
/* Chat 模式当前所选工作空间根目录绝对路径（'' 表示默认工作区；会话按工作空间隔离存储） */
window.currentChatWorkspace = '';

/* 生成新会话 ID：统一 work- 前缀；落盘位置由发送时的 X-Session-Cwd 决定
   （有所属根→该根下=项目会话；无→安装目录=全局会话） */
function newSessionId() {
    return 'work-' + Date.now().toString(36);
}
window.newSessionId = newSessionId;

/* 发送消息时随请求头带上的工作目录（重定向 AI 工具到所选工作空间/项目）。
   code 模式取所选项目；chat 模式取所选工作空间；未选择返回空串（后端使用默认工作区）。 */
function getSessionCwd() {
    if (window.appMode === 'code' && window.currentProjectRoot) return window.currentProjectRoot;
    if (window.appMode !== 'code' && window.currentChatWorkspace) return window.currentChatWorkspace;
    return '';
}
window.getSessionCwd = getSessionCwd;

var SESSION_ID = newSessionId();
var isStreaming = false;
var inChatMode = false;
var chatHistory = [];
var currentChatIndex = -1;
var pendingFiles = [];
var MAX_ATTACHMENTS = 10;
// 输入超过 64 KiB UTF-8 时折叠为 TXT 附件；上传大小由后端配置决定，不在前端人为限制。
var LONG_INPUT_THRESHOLD_BYTES = 64 * 1024;
var userScrolledUp = false;

var onFinishStream = null;

/* 控制台打印简化开关（与后端 cliPrintSimplified 对齐）。
   true：流式工具卡默认收起；false：默认展开。启动时由 /web/settings/general 回填。 */
var cliPrintSimplified = true;

/* ===== Session Helpers ===== */
function getOrCreateSession(sessionId) {
    if (!sessionMap[sessionId]) {
        sessionMap[sessionId] = new SessionState(sessionId);
    }
    return sessionMap[sessionId];
}

/* 会话容器 LRU 淘汰：
   切会话只 hide 不移除 DOM，长时间使用会把浏览过的每个会话的完整消息 DOM 全部累积在
   messagesWrap 中且无上限（长对话单会话可达数千节点），是渲染进程内存的主要增长源。
   这里保留最近 KEEP_ALIVE_SESSIONS 个会话的 DOM，更早的清空其容器内容（容器本身保留，
   仍挂在 messagesWrap 上，sess.container 引用不变）。
   再次进入被淘汰的会话时，selectSession 的 `container.children.length === 0` 判据会
   自动触发 loadMessages 重新拉取，故必须同步重置回放分页状态，否则会误判为「已加载完」。 */
var KEEP_ALIVE_SESSIONS = 3;

function evictInactiveSessions() {
    var alive = [];
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var s = sessionMap[sid];
        if (!s || sid === activeSessionId) continue;
        // 流式中/回放中/网关缓冲中的会话必须保留：清空 DOM 会让正在写入的帧丢失落点
        if (s.isStreaming || s._replaying || s._gateBuffering || s._replayLoadingMore) continue;
        if (!s.container || s.container.children.length === 0) continue;   // 已是空壳，无需处理
        alive.push(s);
    }
    if (alive.length <= KEEP_ALIVE_SESSIONS) return;

    // 最近活跃的排前面，淘汰尾部；无 lastActiveAt（未经 setActiveSession）的视为最旧
    alive.sort(function (a, b) { return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); });
    for (var i = KEEP_ALIVE_SESSIONS; i < alive.length; i++) {
        var sess = alive[i];
        // 先清理增量渲染器/挂起帧与 DOM 引用，再清空容器，避免残留帧写入已摘除的节点
        if (typeof resetStreamState === 'function') resetStreamState(sess);
        $(sess.container).empty();
        // 重置回放分页状态：下次进入走完整 loadMessages 重新拉取
        sess._replayHasMore = false;
        sess._replayRemainingRounds = 0;
        sess._replayFirstSeq = 0;
        sess._replayCoverage = null;
        sess._replayLoadingMore = false;
        // 深度释放 JS 侧大对象：仅 empty() 只断开 DOM，下面这些字段仍会随 SessionState 长期驻留
        // （sessionMap 条目本身除用户主动删会话外不会被移除）。被淘汰的会话下次进入必走
        // loadMessages 完整重建，这些中间态无需保留。
        sess.toolCardsById = {};
        sess.toolBatchesById = {};
        sess.completedActionIds = {};
        sess.agentCards = {};
        sess.pendingToolCard = null;
        sess.approvedToolCard = null;
        sess.retryEl = null;
        // 未排空的实时帧缓冲（恢复失败/中途切走时可能残留整批 chunk 对象）
        sess._gateBuffer = [];
        // 文件变更摘要按 run 累积，每条都带完整 files[]，不清会随会话长期驻留；
        // 且 DOM 已清空而高 revision 快照仍在时，重建期到达的旧 revision 会被单调门禁
        // 直接丢弃，导致卡片再也建不回来。DOM 与快照必须同生共死。
        sess._fileChangesByRun = {};
        sess._fileChangesExpanded = {};
        sess._fileChangesReconciledAt = {};
        sess._fileChangesReplayPending = null;
    }
}

/* ===== Per-Session Input Draft =====
   输入框与附件区都是全局单例 DOM，而会话是多路的：不按会话存取草稿，在 A 输入到一半切到 B，
   内容会跟着显示在 B，且切回 A 也回不来。
   约定：chatInput 始终持有 activeSessionId 的草稿——切走时存回原会话，切入时取出目标会话的。
   欢迎页输入框不参与：每次回欢迎页都会生成全新 sessionId（switchToWelcomeMode），草稿无处可归，
   由 clearInput / switchToWelcomeMode 统一清空。

   注：不能按 inChatMode 判断该读哪个输入框——switchToWelcomeMode 先置 inChatMode=false 再调
   setActiveSession，此时读到的会是欢迎框而非离开会话的真实草稿。 */

/* 草稿保留上限（分两档，因为两类草稿的内存量级差一个数量级）：
   - 附件（draftFiles）：持有 File 与 base64 dataUrl，单会话可达数 MB（最多 10 个附件），
     是真正的内存大头，只保留最近几个会话。
   - 文本（draft）：单条上限 64 KiB（超过即在发送时折叠为 TXT 附件，见
     LONG_INPUT_THRESHOLD_BYTES），为省几 KB 就静默吐掉用户打了一半的字得不偿失；
     给个显著更大的上限做兵底，保证总量有界（最坏约 30 × 64 KiB ≈ 2 MB）。 */
var KEEP_DRAFT_FILE_SESSIONS = 5;
var KEEP_DRAFT_TEXT_SESSIONS = 30;

function saveSessionDraft(sess) {
    if (!sess || !chatInput) return;
    sess.draft = chatInput.value;
    if (typeof pendingFiles === 'undefined') return;
    sess.draftFiles = pendingFiles.length > 0 ? pendingFiles.slice() : null;
}

function restoreSessionDraft(sess) {
    if (!sess || !chatInput) return;
    chatInput.value = sess.draft || '';
    autoResize(chatInput);
    // 补全弹层是按旧输入内容算出来的，换了草稿就失效，不收会跟着悬在新会话上
    if (typeof hideCmdComplete === 'function') hideCmdComplete();
    if (typeof pendingFiles === 'undefined') return;
    // 保持 pendingFiles 数组本身的引用不变（多处模块直接读写它），只换内容
    pendingFiles.length = 0;
    var df = sess.draftFiles;
    if (df) {
        for (var i = 0; i < df.length; i++) pendingFiles.push(df[i]);
    }
    if (typeof renderAttachments === 'function') renderAttachments();
}

/* 只释放草稿附件中的 File/dataUrl 大对象（保留文本） */
function releaseSessionDraftFiles(sess) {
    if (!sess || !sess.draftFiles) return;
    for (var i = 0; i < sess.draftFiles.length; i++) {
        if (typeof releaseAttachmentData === 'function') releaseAttachmentData(sess.draftFiles[i]);
    }
    sess.draftFiles = null;
}

/* 释放某会话的全部草稿（会话被删除时用） */
function releaseSessionDraft(sess) {
    if (!sess) return;
    releaseSessionDraftFiles(sess);
    sess.draft = '';
}

/* 草稿 LRU 回收：与 evictInactiveSessions 分开实现，因为后者会跳过「容器为空」的会话
   （`container.children.length === 0` 直接 continue），而只输入过未发送的会话恰好就是空容器，
   放在那里会永远收不掉。 */
function pruneSessionDrafts() {
    var withFiles = [];
    var withText = [];
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var s = sessionMap[sid];
        if (!s || sid === activeSessionId) continue;   // 当前会话的草稿正显示在输入框里，不能动
        if (s.draftFiles) withFiles.push(s);
        if (s.draft) withText.push(s);
    }
    function byRecencyDesc(a, b) { return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); }
    // 先回收附件（大头），文本单独保留：只掉附件的会话，切回去文字仍在
    if (withFiles.length > KEEP_DRAFT_FILE_SESSIONS) {
        withFiles.sort(byRecencyDesc);
        for (var i = KEEP_DRAFT_FILE_SESSIONS; i < withFiles.length; i++) {
            releaseSessionDraftFiles(withFiles[i]);
        }
    }
    if (withText.length > KEEP_DRAFT_TEXT_SESSIONS) {
        withText.sort(byRecencyDesc);
        for (var k = KEEP_DRAFT_TEXT_SESSIONS; k < withText.length; k++) {
            withText[k].draft = '';
        }
    }
}

function setActiveSession(sessionId) {
    // 同会话重复激活（发送、selectSession、初始化都会触发）不能走草稿交换：
    // 那是无谓的 renderAttachments 重建，也会白白作废正在读取的附件回调。
    var switching = (sessionId !== activeSessionId);
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
        // 切走前把输入框内容存回原会话，切回来才能原样恢复
        if (switching) saveSessionDraft(sessionMap[activeSessionId]);
    }
    var sess = getOrCreateSession(sessionId);
    if (switching) {
        // 使切换途中到达的 FileReader 回调失效，避免上一个会话正在读取的附件落进新会话
        if (typeof _pendingFilesVersion !== 'undefined') _pendingFilesVersion++;
        restoreSessionDraft(sess);
    }
    $(sess.container).show();
    sess.lastActiveAt = Date.now();
    activeSessionId = sessionId;
    SESSION_ID = sessionId;
    isStreaming = sess.isStreaming;
    userScrolledUp = false;
    // 切会话必须释放可能残留的视口锚锁（上一个会话的翻页还在飞行中就切走），
    // 否则新会话的自动滚到底部会被锁死，表现为流式输出不跟随。
    if (typeof releaseScrollAnchor === 'function') releaseScrollAnchor();
    if (isStreaming) setBtnStopMode();
    else setBtnSendMode();
    // 清除 messagesWrap 中所有残留的加载按钮（按钮是 messagesWrap 直接子元素，不属于 sess.container，
    // 切会话时不会被 hide，需主动清除；后续 updateLoadMoreBtn 按需重建当前会话的按钮）
    $(messagesWrap).find('.chat-load-more-wrapper').remove();
    // 仅统一前缀（work-）的会话才刷新模型选择器（旧前缀残留 id 跳过，避免误建会话目录）
    if (typeof modelsLoaded !== 'undefined' && modelsLoaded) {
        if (sessionId && sessionId.indexOf('work-') === 0) {
            refreshSessionModel(sessionId);
        }
    }
    // 按会话恢复上下文指示器（该会话有历史用量则回填，否则清空）
    if (typeof restoreContextIndicator === 'function') restoreContextIndicator(sess);
    else if (typeof resetContextIndicator === 'function') resetContextIndicator();
    // 切换完成后回收较早会话的 DOM 与草稿（当前会话已置为 active，不会被误淘汰）
    evictInactiveSessions();
    pruneSessionDrafts();
}

function deactivateSession() {
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
        // 与 setActiveSession 对齐：startFreshSession 会先 deactivate 再激活新会话，
        // 不在这里存一次，离开会话的草稿就丢了
        saveSessionDraft(sessionMap[activeSessionId]);
    }
    activeSessionId = null;
    isStreaming = false;
    setBtnSendMode();
}

/* ===== Helpers ===== */
$(messagesWrap).on('scroll', function() {
    var gap = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight;
    userScrolledUp = gap > 80;
});
/* ===== 视口锚定锁（历史向上翻页期间禁用一切自动滚动） =====
   向上翻页时用户明确在读旧内容，而此时任务可能仍在运行：回放缓冲排空会补发实时帧，
   其中的 done 帧走 finishStream → scrollToBottom(true)，force 语义会无视 userScrolledUp
   直接把视口拽到底部，正是「往上拉后位置乱跳」的元凶。翻页窗口内统一挂锁屏蔽。
   锁带安全阀定时器：请求失败等异常路径没走到 release 时，不会永久锁死自动滚动。 */
var _scrollAnchorHold = false;
var _scrollAnchorHoldTimer = null;
function holdScrollAnchor(maxMs) {
    _scrollAnchorHold = true;
    if (_scrollAnchorHoldTimer) clearTimeout(_scrollAnchorHoldTimer);
    _scrollAnchorHoldTimer = setTimeout(releaseScrollAnchor, maxMs || 8000);
}
function releaseScrollAnchor() {
    _scrollAnchorHold = false;
    if (_scrollAnchorHoldTimer) { clearTimeout(_scrollAnchorHoldTimer); _scrollAnchorHoldTimer = null; }
}
function isScrollAnchorHeld() { return _scrollAnchorHold; }

var scrollRafPending = false;
function scrollToBottom(force) {
    if (isScrollAnchorHeld()) return;
    if (!force && userScrolledUp) return;
    if (force) userScrolledUp = false;
    // 滚动与内容更新在同一次 rAF 内执行，避免跨帧跳动
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(function() {
        // 挂锁可能发生在本次调度之后，落地前需再判一次，否则挂起帧仍会把视口拽走
        if (isScrollAnchorHeld()) { scrollRafPending = false; return; }
        // 若当前帧内有多次滚动调用，确保最终落在最底部
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
        // 再等下一帧确认高度稳定后再次修正（始终执行，确保最终落在最底部）
        requestAnimationFrame(function() {
            scrollRafPending = false;
            if (isScrollAnchorHeld()) return;
            messagesWrap.scrollTop = messagesWrap.scrollHeight;
        });
    });
}

function resetStreamState(sess) {
    // R2 修复：思考块引用被清空前，必须先走正规收敛（停 setInterval + 摘 .streaming 闪烁类）。
    // 旧实现直接把 thinkingBlockEl 置 null，DOM 上的闪烁动画与计时器就此失联：
    // 会话切换 / 中断等不经过 finishStream 的路径下，思考块会永久闪烁且计时器永久持有。
    // 必须放在 disposeSessionStreamMd 之前：收敛过程需要调用增量渲染器的 finish()。
    try {
        if (typeof finishThinkingBlockCore === 'function') finishThinkingBlockCore(sess, sess);
        if (typeof finishAgentThinkingBlock === 'function') finishAgentThinkingBlock(sess);
        if (typeof purgeInlineThinking === 'function') purgeInlineThinking(sess);
    } catch (e) { /* 收敛失败不应阻断状态重置 */ }
    // 相位一并复位，避免下一轮沿用上一轮的相位误报等待语义
    sess.phase = null;
    // 先处置增量渲染器（取消挂起帧），再清空元素引用，避免会话切换后残留帧写入旧 DOM
    if (typeof disposeSessionStreamMd === 'function') disposeSessionStreamMd(sess);
    sess.currentBubbleEl = null;
    sess.pendingToolStarted = false;
    sess.completedActionIds = {};
    sess.reasonBuffer = '';
        sess.thinkingBlockEl = null;
        sess.thinkingBodyMdEl = null;
        sess.thinkingBodyWrapEl = null;
        sess.thinkingBuffer = '';
        sess.thinkingUserScrolledUp = false;
    if (sess.contentRafId) { cancelAnimationFrame(sess.contentRafId); sess.contentRafId = null; }
    if (sess.reasonRafId) { cancelAnimationFrame(sess.reasonRafId); sess.reasonRafId = null; }
    // 取消可能正在进行的回放分片（切换会话时清理）
    if (sess._replayRafId) { cancelAnimationFrame(sess._replayRafId); sess._replayRafId = null; }
    // 清除智能体输出标记
    if (typeof clearAgentState === 'function') clearAgentState(sess);
}

function setBtnStopMode() {
    chatSendBtn.disabled = false;
    $(chatSendBtn).addClass('stop-mode');
    $(chatSendBtn).html('<div class="stop-icon"></div>');
    chatSendBtn.title = GourdI18n.t('base.stop_generating');
    setRunHintVisible(true);
}
function setBtnSendMode() {
    $(chatSendBtn).removeClass('stop-mode');
    $(chatSendBtn).html('<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>');
    chatSendBtn.title = GourdI18n.t('base.send');
    chatSendBtn.disabled = false;
    setRunHintVisible(false);
}

/* ===== 任务执行中的键位提示 =====
   执行中 Enter/Tab 的含义与空闲时不同（Enter=即时插话、Tab=加入队列），两处同步提示：
   1) 输入框 placeholder 切为执行态文案；
   2) chip 行内的键位提示条（用户已开始打字、placeholder 消失后依然可见）。 */
window._runHintVisible = false;
function setRunHintVisible(show) {
    show = !!show;
    window._runHintVisible = show;
    var hint = document.getElementById('chatRunHint');
    if (hint) hint.style.display = show ? 'flex' : 'none';
    // chip 容器显隐由 todo/queue/提示条三方汇算（只要任一可见就得显示）
    if (typeof window.updateChipWrapVisibility === 'function') window.updateChipWrapVisibility();
    applyChatPlaceholder();
}

/* 按当前运行状态回填对话输入框 placeholder。
   注：data-i18n-placeholder 会在语言包就绪/切语言时被 i18n 无条件重写，
   所以这里不改 data-i18n-placeholder 属性，而是在 localeChanged 之后再跡一次。 */
function applyChatPlaceholder() {
    if (!chatInput || !window.GourdI18n) return;
    chatInput.placeholder = GourdI18n.t(window._runHintVisible ? 'app.placeholder_chat_running' : 'app.placeholder_chat');
}

// 语言包就绪 / 用户切语言后，i18n 会把 placeholder 重置回空闲态文案，在其之后重新应用执行态文案
document.addEventListener('i18n:localeChanged', applyChatPlaceholder);

// Input box height: by default auto-adapts to content (capped at 320px);
// after the user drags the top drag bar, el._manualH is written and switches to manual fixed height (double-click the drag bar to restore auto).
function autoResize(el) {
    if (el._manualH) { el.style.height = el._manualH + 'px'; return; }
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
}

function escapeHtml(str) {
    var div = $('<div>')[0];
    $(div).text(str);
    return div.innerHTML;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatMsgTime(ts) {
    if (!ts) return '';
    var d = new Date(typeof ts === 'number' ? ts : parseInt(ts));
    if (isNaN(d.getTime())) return '';
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
    if (sameDay) return hh + ':' + mm;
    var yyyy = d.getFullYear();
    var MM = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + MM + '-' + dd + ' ' + hh + ':' + mm;
}

function getInputText() {
    if (inChatMode) return chatInput.value.trim();
    return welcomeInput.value.trim();
}
function clearInput() {
    // 两个输入框都要清：从欢迎页发出的首条消息会先 switchToChatMode() 把 inChatMode 置为 true，
    // 只按当前模式清就会漏掉 welcomeInput，其原文一直残留到下次回欢迎页
    // （表现为「新建对话带上了上次的内容」）。
    // Go through autoResize uniformly: if there is no manual height, revert to the default min-height; if there is, preserve the height selected by the user
    chatInput.value = '';
    autoResize(chatInput);
    welcomeInput.value = '';
    autoResize(welcomeInput);
    // 同步清掉当前会话的草稿，否则发送后切走再切回，已发送的内容会被再恢复出来
    if (activeSessionId && sessionMap[activeSessionId]) {
        sessionMap[activeSessionId].draft = '';
    }
}

/* ===== Toast Notification ===== */
var toastContainer = null;
function showToast(message, type, duration) {
    if (!toastContainer) {
        toastContainer = $('<div>')[0];
        $(toastContainer).addClass('toast-container');
        $('body').append(toastContainer);
    }
    var item = $('<div>')[0];
    $(item).addClass('toast-item ' + (type || 'info'));
    var icons = { success: '\u2714', error: '\u2716', info: '\u2139' };
    $(item).html('<span>' + (icons[type] || icons.info) + '</span><span>' + escapeHtml(message) + '</span>');
    $(toastContainer).append(item);
    setTimeout(function() {
        $(item).addClass('leaving');
        setTimeout(function() {
            if (item.parentNode) $(item).remove();
        }, 250);
    }, duration || 3000);
}

/* ===== Network Status Bar ===== */
var networkBar = null;
function showNetworkBar(type, message) {
    if (!networkBar) {
        networkBar = $('<div>')[0];
        $(networkBar).addClass('network-bar');
        $('body').append(networkBar);
    }
    $(networkBar).attr('class', 'network-bar show ' + type);
    $(networkBar).text(message);
}
function hideNetworkBar() {
    if (networkBar) {
        $(networkBar).attr('class', 'network-bar');
    }
}

/* ===== Layer Dialog Helpers ===== */
/* 统一用 layui layer 替代原生 confirm/alert，自动跟随主题 */
function layConfirm(msg, yesFn) {
    var html = '<div class="kd-confirm">'
        + '<div class="kd-confirm-msg">' + escapeHtml(msg) + '</div>'
        + '<div class="kd-confirm-btns">'
         + '<button class="kd-btn kd-btn-cancel">' + GourdI18n.t('base.cancel') + '</button>'
         + '<button class="kd-btn kd-btn-ok">' + GourdI18n.t('base.confirm') + '</button>'
        + '</div></div>';
    var idx = layer.open({
        type: 1,
        content: html,
        title: false,
        closeBtn: 0,
        shade: 0.3,
        shadeClose: false,
        skin: 'kd-layer',
        area: 'auto',
        success: function(layero) {
            layero.find('.kd-btn-ok').on('click', function() {
                layer.close(idx);
                yesFn();
            });
            layero.find('.kd-btn-cancel').on('click', function() {
                layer.close(idx);
            });
        }
    });
}

function layAlert(msg) {
    layer.msg(msg, { icon: 2, time: 3000, skin: 'kd-layer-msg' });
}
