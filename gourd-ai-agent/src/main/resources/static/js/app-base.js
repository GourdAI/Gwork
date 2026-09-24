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
    // 渲染落点：null 表示新节点直接落进真实容器；回放期指向游离的临时容器（见 renderRoot）
    this.renderTarget = null;
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

/* 项目登记表（projects.json）变更广播：重命名 / 新增 / 移除 / 新建 成功后调用。
   各持有项目列表副本的视图（欢迎页工作空间选择器、记忆页项目选择器、自动化工作空间选择器）
   监听 'projects:changed' 重拉列表即可即时跟上新显示名，无需刷新页面或手动点刷新。 */
function notifyProjectsChanged() {
    document.dispatchEvent(new CustomEvent('projects:changed'));
}
window.notifyProjectsChanged = notifyProjectsChanged;

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
        // 先清理增量渲染器/挂起帧与 DOM 引用，再清空容器，避免残留帧写入已摘除的节点。
        // 本函数要清空会话 DOM，与回放冲突，故显式中止回放并完整收尾。
        // 注：上方过滤已跳过 _replaying 的会话，因此这里通常是 no-op——保留调用是防御性的
        // （过滤条件将来若放宽，这里仍能兜住），并顺带清理可能残留的回放 rAF 句柄。
        if (typeof abortReplay === 'function') abortReplay(sess);
        // destroying：紧接着就要 empty() 掉整个容器，子代理状态必须全量回收（停计时器 + 释放
        // 增量渲染器），否则 agentStates 会钉住已摘除的卡片子树，表现为「清了 DOM 内存却不降」。
        if (typeof resetStreamState === 'function') resetStreamState(sess, { destroying: true });
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
        // 与 agentCards 同生共死：上面的 resetStreamState({destroying:true}) 已做过正规回收，
        // 这里是防御性兜底（将来若有人改动上方调用，两张表也不会只清一张而失配）。
        sess.agentStates = {};
        sess.pendingToolCard = null;
        sess.approvedToolCard = null;
        sess.retryEl = null;
        // 未排空的实时帧缓冲（恢复失败/中途切走时可能残留整批 chunk 对象）
        sess._gateBuffer = [];
        // 文件变更摘要按 run 累积，每条都带完整 files[]，不清会随会话长期驻留；
        // 且容器已清空而高 revision 快照仍在时，重建期到达的旧 revision 会被单调门禁
        // 直接丢弃，入口再也建不回来。展示状态与缓存必须同生共死。
        sess._fileChangesByRun = {};
        sess._fileChangesLatestRun = null;
        sess._fileChangesReconciledAt = {};
        sess._fileChangesReplayPending = null;
        sess._fchRenderPending = null;
    }
}

/* ===== Per-Session Input Draft =====
   输入框与附件区都是全局单例 DOM，而会话是多路的：不按会话存取草稿，在 A 输入到一半切到 B，
   内容会跟着显示在 B，且切回 A 也回不来。
   约定：chatInput 始终持有 activeSessionId 的草稿——切走时存回原会话，切入时取出目标会话的。
   欢迎页文本不走按会话草稿：输入框是常驻 DOM，hide/show 不丢值，未发送内容天然保留，
   只在发送消费后清空（clearInput(fromWelcome)）。
   欢迎页附件另走全局槽 welcomeDraftFiles：pendingFiles 是全局单例，切会话时会被存进
   「欢迎页临时会话」的 draftFiles 孤儿化，故在模式切换边界显式 stash/restore（见下）。

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

/* ===== Welcome-page Attachment Draft =====
   欢迎页输入区可见期间（welcomeFilesActive），pendingFiles 归属欢迎页；离开欢迎页
   （切会话/发送/新建对话）前 stash 进槽，回欢迎页时 restore，避免被 setActiveSession
   存进临时会话 draftFiles 后孤儿化回收。
   槽仅在「已 stash」态非空（此时 welcomeFilesActive 必为 false），两态互斥，保证同一批
   附件对象不同时被槽与某会话 draftFiles 持有而被 pruneSessionDrafts 误释放。 */
var welcomeDraftFiles = null;
var welcomeFilesActive = false;

function stashWelcomeDraftFiles() {
    if (!welcomeFilesActive) return;
    welcomeFilesActive = false;
    if (pendingFiles.length === 0) return;
    releaseWelcomeDraftFiles();
    welcomeDraftFiles = pendingFiles.slice();
    pendingFiles.length = 0;
    if (typeof renderAttachments === 'function') renderAttachments();
}

function restoreWelcomeDraftFiles() {
    if (!welcomeDraftFiles) return;
    pendingFiles.length = 0;
    for (var i = 0; i < welcomeDraftFiles.length; i++) pendingFiles.push(welcomeDraftFiles[i]);
    welcomeDraftFiles = null;
    welcomeFilesActive = true;
    if (typeof renderAttachments === 'function') renderAttachments();
}

function releaseWelcomeDraftFiles() {
    if (!welcomeDraftFiles) return;
    for (var i = 0; i < welcomeDraftFiles.length; i++) {
        if (typeof releaseAttachmentData === 'function') releaseAttachmentData(welcomeDraftFiles[i]);
    }
    welcomeDraftFiles = null;
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
    // 结构化问答卡归属活动会话：切换即按新会话状态重建/隐藏（切回时由回放重建）
    if (typeof syncQuestionCard === 'function') syncQuestionCard();
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
    // 结构化问答卡归属活动会话：离开即隐藏（切回时由回放重建）
    if (typeof syncQuestionCard === 'function') syncQuestionCard();
    isStreaming = false;
    setBtnSendMode();
}

/* ===== Helpers ===== */
/* 文件线性图标：内联 SVG 以 currentColor 跟随主题色；📎 emoji 在深色主题/无 emoji 字体下
   渲染为黑框轮廓字形，与芯片样式冲突，故弃用 */
function fileIconSvg(size) {
    var s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
        + '<path d="M4 1.5h4.75L12.5 5.75V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>'
        + '<path d="M8.75 1.5v4.25H12.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
}

/* 滚动意图判定与统一置底（唯一的 messagesWrap 外层滚动入口）
   抖动教训（三条，缺一不可）：
   1) 调度期预清 userScrolledUp（旧 `if (force) userScrolledUp = false;`）会让调度与落地
      之间夹进的上滚被残留帧覆盖 → 往复抖动。复位点必须挪到「落地成功之后」。
   2) 不要用时间窗滤除程序性 scroll 事件：连续输出时每个 chunk 都在刷新窗口，窗口恒常开启，
      会把用户滚轮的真实事件一并吞掉，userScrolledUp 永远置不起来 → 跟随停不下来，抖动依旧。
      程序性置底把视口放到底部，gap≈0，裸判自然得出 false，无需任何过滤。
   3) userScrolledUp 需要一条可靠复位通道：force 置底（showThinking / Loop 注入 / 历史跳转）
      落地后立即复位，否则标志停在 true，人在底部却不再跟随。
   另：滚动请求带 generation，被更新一世的请求取代后，旧世代挂起帧一律作废。 */
var _scrollGen = 0;
$(messagesWrap).on('scroll', function() {
    // 裸判：程序置底后 gap≈0 自然得 false，不需要来源过滤（过滤会误吞用户事件）
    var gap = messagesWrap.scrollHeight - messagesWrap.scrollTop - messagesWrap.clientHeight;
    userScrolledUp = gap > 80;
});
function scrollToBottom(force) {
    if (isScrollAnchorHeld()) return;
    if (!force && userScrolledUp) return;
    // 同一时间只保留最新一代请求：被更新世代取代的挂起帧一律作废，
    // 杜绝「用户上滚 → 被残留帧拉回 → 再上滚」的往复抖动
    var gen = ++_scrollGen;
    // 两帧共用同一守卫：落地前复查锚定锁与用户意图，
    // 调度到落地之间发生的上滚不会被残留帧覆盖；不用 applied 去重——
    // 第二帧若内容高度已稳定且不在底部需再次修正（同值赋值浏览器为 no-op，不产生多余 scroll 事件）
    var applyIfAllowed = function() {
        if (isScrollAnchorHeld() || (!force && userScrolledUp)) return;
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
        // 落地后复位：此刻视口确实在底部，标志与实际位置保持一致。
        // force 路径尤其依赖这里 —— 否则标志永久停在 true，后续非 force 帧全被入口挡掉。
        userScrolledUp = false;
    };
    requestAnimationFrame(function() {
        if (gen !== _scrollGen) return;
        applyIfAllowed();
        // 内容高度可能跨帧变化（图片/Mermaid/代码块），下一帧复查后再修正
        requestAnimationFrame(function() {
            if (gen !== _scrollGen) return;
            applyIfAllowed();
        });
    });
}
/* ===== 视口锚定锁（历史向上翻页期间禁用一切自动滚动） =====
   向上翻页时用户明确在读旧内容，而此时任务可能仍在运行：回放缓冲排空会补发实时帧。
   done 帧本身已改为非 force（见 finishStream），但 force 调用者仍在（showThinking /
   Loop 注入的 user_input / 历史跳转），force 语义会无视 userScrolledUp 直接把视口拽到底部，
   正是「往上拉后位置乱跳」的元凶。翻页窗口内统一挂锁屏蔽。
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

/* ===== 渲染落点（render target） =====
   sess.container 的语义恒定：永远是该会话挂在文档里的真实消息容器。任何时候都可以安全地
   用它做滚动计算、相对定位（「加载更多」按钮是它的前兄弟节点）、存在性检查与整体清空。

   历史回放需要先把大批 DOM 建在游离的临时容器里、再一次性移入真实容器（避免逐条 append
   触发几百次 layout）。旧实现的做法是回放期间把 sess.container 整个替换成临时 div、结束再
   换回，这让「容器」在一段时间内既不是真实容器、也不在文档中，代价是两类严重缺陷：
     1) 回放一旦被打断（分片 rAF 被 resetStreamState 取消、或回放中途抛异常），替换永不回滚，
        sess.container 就永久指向那个孤儿节点。此后所有渲染都写进看不见的地方，后端照常推流，
        界面却再也不更新——即「任务一直在执行中，但没有后续消息展示」。
     2) 依赖真实容器语义的逻辑（updateLoadMoreBtn 的 document.contains 与 .prev()、会话判空、
        异常兜底清空半成品）在整个回放窗口内静默失效。

   现在容器字段不动，另设 sess.renderTarget 显式表达「这一刻新节点该落在哪」：回放期指向临时
   容器，平时为 null。渲染类代码一律经 renderRoot(sess) 取落点，真实容器语义的代码继续直接用
   sess.container。两种语义不再共用一个字段，回放中断也就不可能再让界面僵死。*/
function renderRoot(sess) {
    if (!sess) return null;
    return sess.renderTarget || sess.container;
}

/* 当前是否正在把内容渲染进游离的临时容器（即回放进行中）。
   面向用户可见区域的副作用（滚动跟随等）在这种时候必须跳过：节点还没进文档，
   滚动既无意义又会打断用户正在看的位置。 */
function isDetachedRenderTarget(sess) {
    return !!(sess && sess.renderTarget && sess.renderTarget !== sess.container);
}

/* ===== 流式管线异常留痕 =====
   帧分发链路（onmessage → applySequencedGateChunk → dispatchGateChunk → onWebChunk）上
   原本散布着数个 `catch (e) {}` 空捕获。它们的本意是「单帧出错不拖垮整条流」，方向没错，
   但空捕获把证据一起销毁了，于是留下一类无法排查的事故：

     done 帧在 dispatchGateChunk 的前置分支里处理完即 return，根本不经过 onWebChunk；
     而正文/思考/工具帧全部走 onWebChunk。一旦某个渲染状态损坏使 onWebChunk 稳定抛异常，
     内容帧被逐条静默丢弃，done 却畅通无阻 —— 界面定格在中途、停止按钮却正常复位成发送态，
     控制台一行日志都没有。事故会话 work-mub8ph5g 即是此形态：后端跑完 12 分钟约 370 帧，
     界面停在一个空白思考框上。

   故统一走本函数：仍然不让异常上抛（保持「不崩主流程」语义不变），但必须留下现场。
   同一 where 只详细打印首次（含堆栈），其后仅累加计数，避免高频帧把控制台刷爆。 */
var streamPipelineErrorStats = {};
function reportStreamPipelineError(where, err, chunk) {
    try {
        var stat = streamPipelineErrorStats[where];
        if (!stat) stat = streamPipelineErrorStats[where] = { count: 0, firstAt: Date.now(), lastErr: null };
        stat.count++;
        stat.lastAt = Date.now();
        stat.lastErr = err;
        // 帧身份信息是定位的关键：出事那一帧的 type/seq 决定了该去看哪条渲染分支
        var id = chunk
            ? (chunk.type || '?') + ' seq=' + (chunk.eventSeq || '-')
                + (chunk.toolName ? ' tool=' + chunk.toolName : '')
                + (chunk.runId ? ' run=' + String(chunk.runId).slice(0, 8) : '')
            : '(no chunk)';
        if (stat.count === 1) {
            console.error('[stream-pipeline] ' + where + ' 处理帧失败: ' + id, err);
            if (err && err.stack) console.error(err.stack);
        } else if (stat.count === 5 || stat.count % 50 === 0) {
            console.error('[stream-pipeline] ' + where + ' 已累计失败 ' + stat.count + ' 帧（最近: ' + id + '）', err);
        }
    } catch (e) { /* 留痕本身绝不能成为新的故障源 */ }
}

/* 控制台自查入口：卡住时执行 gourdStreamDiag() 即可看到各环节的失败计数与最近一次异常。 */
function gourdStreamDiag() {
    var out = {};
    for (var k in streamPipelineErrorStats) {
        if (!streamPipelineErrorStats.hasOwnProperty(k)) continue;
        var s = streamPipelineErrorStats[k];
        out[k] = { count: s.count, firstAt: new Date(s.firstAt).toLocaleString(), lastAt: new Date(s.lastAt).toLocaleString(), lastErr: String(s.lastErr) };
    }
    if (!Object.keys(out).length) console.log('[stream-pipeline] 无异常记录');
    else console.table(out);
    return out;
}
if (typeof window !== 'undefined') window.gourdStreamDiag = gourdStreamDiag;

/* 中止进行中的历史回放并完整收尾。
   注意 resetStreamState 已不再负责取消回放分片（见其内注释）：只有真正要销毁或重建会话 DOM
   的路径（LRU 淘汰、删除会话）才应调用本函数。收尾必须同时做三件事，缺任何一件都会留下
   「后端在跑、界面不动」的僵死态：还原渲染落点、释放回放/缓冲门禁、排空已堆积的实时帧。
   半成品随临时容器一起丢弃——调用方本就要重建 DOM，下次进入会重新拉取。 */
function abortReplay(sess) {
    if (!sess) return false;
    /* rAF 句柄的清理放在门禁判定之前，且不受 _replaying 约束：正常收尾路径
       （replayDoneCore / finishReplayFallback）都是「释放门禁」与「清句柄」同步成对，
       但那是约定而非结构保证。将来若有路径只释放门禁却漏清句柄，残留的挂起帧会在容器
       被清空后继续往已摘除的节点渲染。提前无条件清理即可覆盖该情形，代价为零。 */
    if (sess._replayRafId) { cancelAnimationFrame(sess._replayRafId); sess._replayRafId = null; }
    // 返回值只表示「是否真的中止了一次进行中的回放」：非回放态必须原样返回 false，
    // 尤其不得误排空 _gateBuffer（那会把尚未轮到的实时帧提前喂给一个没有落点的会话）。
    if (!sess._replaying) return false;
    sess._replaying = false;
    sess._replayClock = null;
    sess._skipScroll = false;
    sess.renderTarget = null;
    sess._replayLoadingMore = false;
    if (typeof releaseScrollAnchor === 'function') releaseScrollAnchor();
    if (typeof drainGateBuffer === 'function') drainGateBuffer(sess);
    return true;
}

/* opts.destroying=true：调用方紧接着就要销毁会话 DOM（evictInactiveSessions 的 $(container).empty()），
   此时必须全量清理子代理状态，不得保留任何活跃卡——理由见下方 clearAgentState 调用处的注释。 */
function resetStreamState(sess, opts) {
    // R2 修复：思考块引用被清空前，必须先走正规收敛（停 setInterval + 摘 .streaming 闪烁类）。
    // 旧实现直接把 thinkingBlockEl 置 null，DOM 上的闪烁动画与计时器就此失联：
    // 会话切换 / 中断等不经过 finishStream 的路径下，思考块会永久闪烁且计时器永久持有。
    // 必须放在 disposeSessionStreamMd 之前：收敛过程需要调用增量渲染器的 finish()。
    try {
        if (typeof finishThinkingBlockCore === 'function') finishThinkingBlockCore(sess, sess);
        if (typeof finishAgentThinkingBlock === 'function') finishAgentThinkingBlock(sess);
        // removeThinking 停的是消息区独立「圆点 + 相位文案 + Ns」等待行的计时器并移除元素；
        // 旧实现只收了气泡内指示器（purgeInlineThinking），漏了它，导致不经过 finishStream 的
        // 收尾路径（会话切换 / 中断对账）会留下永久闪动等待行与一直跳的计时器。
        if (typeof removeThinking === 'function') removeThinking(sess);
        if (typeof purgeInlineThinking === 'function') purgeInlineThinking(sess);
    } catch (e) { /* 收敛失败不应阻断状态重置 */ }
    // 相位一并复位，避免下一轮沿用上一轮的相位误报等待语义
    sess.phase = null;
    // 本轮进入流式的起点：看门狗在“尚无任何 chunk 事件”时用它判断是否已停摆
    sess._streamStartAt = Date.now();
    // lastEventAt 是上一轮遗留值，必须一并归零：停摆判定若短路取到它，
    // 会把「新 run 刚发起、服务端 running 尚为 false」的启动窗口误判为停摆而误砍。
    sess.lastEventAt = 0;
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
    // 交错思考复用窗口一并清零：跨轮/跨会话不得复用旧 run 的思考块（见 app-message.js ensureThinkingBlockCore）
    sess._lastFinishedThinkingBlockEl = null;
    sess._lastFinishedThinkingAt = 0;
    sess._lastThinkingRunId = null;
    sess._thinkingInterruptedByAction = false;
    if (sess.contentRafId) { cancelAnimationFrame(sess.contentRafId); sess.contentRafId = null; }
    if (sess.reasonRafId) { cancelAnimationFrame(sess.reasonRafId); sess.reasonRafId = null; }
    /* 回放分片链不能在这里取消——这正是「任务执行中但界面停止更新」的直接成因。
       回放按帧分片执行（每帧 50 事件，上万事件的会话要跑几百帧、十几秒），而本函数会被
       发送消息、静默命令、问答卡作答等多条路径无条件调用。旧实现在此
       cancelAnimationFrame(sess._replayRafId)，回放链一旦被掐断，replayDone 永不执行 →
       _replaying/_gateBuffering 门禁永不释放 → 后续实时帧全被扣在 _gateBuffer 里：
       后端照常推流、底部任务计数照常跳动，消息区却定格在最后一条。
       渲染落点与真实容器解耦后（见 renderRoot），回放继续跑不会污染实时流——它写进自己的
       临时容器，结束时整体移入。确需销毁回放的路径请显式调用 abortReplay。*/
    /* 清除智能体输出标记——但必须保留【卡片仍在文档中】的活跃子代理。
       本函数会被发消息、静默命令、问答卡作答等多条路径无条件调用，而这些动作都可能发生在
       子代理正跑的时候（子代理动辄跑几分钟）。旧实现在此全量清空 agentStates/agentCards，
       后果是两重的：
         1) resolveAgentState 对后续所有子代理帧返回 null → 内容全部漏进主对话，
            卡片内部再也不增加任何消息；
         2) agent_end 因 agentCards[agentId] 已不存在而进不了收卡分支，改去新建第二张卡，
            原卡的 .agent-status-icon.loading （infinite 动画）永远闪烁。
       合起来就是「只有状态标在闪、子智能体内部不再加载任何消息，而后台接口一直在调」。

       【destroying 必须由销毁方显式传入，不能靠「卡片已离开文档」自动兜底】
       evictInactiveSessions 的顺序是 resetStreamState() → $(container).empty()：调用本函数时
       卡片仍挂在文档上（会话容器即便 hide() 也在 document 内），isAgentStateAlive 恒为真 →
       活跃状态被留下；而 empty() 之后该会话不会再有第二次调用来回收它们，agentStates 就会
       长期钉住已摘除的卡片子树（连带 _streamMd.buf 全文）且思考计时器不停——正是
       clearAgentState 注释里警告的那类「清了 DOM 内存却不降」。
       回放路径无需在此传参：clearAgentState 内部按 sess._replaying 另行否决（见该函数注释）。 */
    if (typeof clearAgentState === 'function') {
        clearAgentState(sess, null, { keepActive: !(opts && opts.destroying) });
    }
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
/* 问答挂起标志：app-message.js syncQuestionCard 按活动会话维护（存在未提交待答题 = true）。
   优先级高于运行态提示——问答挂起期会话不在 streaming，主输入框打字会被记为当前题答案。 */
window._questionPendingHint = false;
function setRunHintVisible(show) {
    show = !!show;
    window._runHintVisible = show;
    var hint = document.getElementById('chatRunHint');
    if (hint) hint.style.display = show ? 'flex' : 'none';
    // chip 容器显隐由 todo/queue/提示条三方汇算（只要任一可见就得显示）
    if (typeof window.updateChipWrapVisibility === 'function') window.updateChipWrapVisibility();
    applyChatPlaceholder();
}

/* 按当前状态回填对话输入框 placeholder，优先级：问答挂起 > 任务执行中 > 空闲。
   注：data-i18n-placeholder 会在语言包就绪/切语言时被 i18n 无条件重写，
   所以这里不改 data-i18n-placeholder 属性，而是在 localeChanged 之后再跡一次。 */
function applyChatPlaceholder() {
    if (!chatInput || !window.GourdI18n) return;
    var key = 'app.placeholder_chat';
    if (window._questionPendingHint) key = 'app.placeholder_chat_question';
    else if (window._runHintVisible) key = 'app.placeholder_chat_running';
    chatInput.placeholder = GourdI18n.t(key);
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
function clearInput(fromWelcome) {
    // chatInput 必清；welcomeInput 仅在本次发送源自欢迎页时清：
    // 欢迎页草稿现在要跨页保留，会话模式发送若连带清空，会把欢迎页未发送的草稿一起丢掉。
    // 欢迎页发送会先 switchToChatMode() 把 inChatMode 置为 true，按当前模式判断不了来源，
    // 须由调用方显式传入（sendMessage 在切换前捕获）。
    // Go through autoResize uniformly: if there is no manual height, revert to the default min-height; if there is, preserve the height selected by the user
    chatInput.value = '';
    autoResize(chatInput);
    if (fromWelcome) {
        welcomeInput.value = '';
        autoResize(welcomeInput);
        // 发送已消费欢迎页附件（switchToChatMode 将其 stash 进槽），同步释放槽内大对象
        releaseWelcomeDraftFiles();
    }
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
