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
    this.isStreaming = false;
    this.currentBubbleEl = null;
    this.reasonBuffer = '';
    this.thinkingBlockEl = null;
    this.thinkingBodyMdEl = null;
    this.thinkingBodyWrapEl = null;
    this.thinkingBuffer = '';
    this.pendingToolCard = null;
    this.pendingToolStarted = false;
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
    this.thinkingUserScrolledUp = false;  // 思考区用户主动向上滚动标记
    // 最近一次 context_size 快照：上下文指示器是全局单例 DOM，靠它按会话回填，使切会话不丢失用量/缓存指标
    this.lastContextChunk = null;
    // 最后一次被激活的时间戳，供容器 LRU 淘汰排序（见 evictInactiveSessions）
    this.lastActiveAt = 0;

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
        sess._replayTotalCount = 0;
        sess._replayHasMore = false;
        sess._replayLoadedCount = 0;
        sess._replayCoverage = null;
        sess._replayLoadingMore = false;
    }
}

function setActiveSession(sessionId) {
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
    }
    var sess = getOrCreateSession(sessionId);
    $(sess.container).show();
    sess.lastActiveAt = Date.now();
    activeSessionId = sessionId;
    SESSION_ID = sessionId;
    isStreaming = sess.isStreaming;
    userScrolledUp = false;
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
    // 切换完成后回收较早会话的 DOM（当前会话已置为 active，不会被误淘汰）
    evictInactiveSessions();
}

function deactivateSession() {
    if (activeSessionId && sessionMap[activeSessionId]) {
        $(sessionMap[activeSessionId].container).hide();
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
var scrollRafPending = false;
function scrollToBottom(force) {
    if (!force && userScrolledUp) return;
    if (force) userScrolledUp = false;
    // 滚动与内容更新在同一次 rAF 内执行，避免跨帧跳动
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(function() {
        // 若当前帧内有多次滚动调用，确保最终落在最底部
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
        // 再等下一帧确认高度稳定后再次修正（始终执行，确保最终落在最底部）
        requestAnimationFrame(function() {
            scrollRafPending = false;
            messagesWrap.scrollTop = messagesWrap.scrollHeight;
        });
    });
}

function resetStreamState(sess) {
    // 先处置增量渲染器（取消挂起帧），再清空元素引用，避免会话切换后残留帧写入旧 DOM
    if (typeof disposeSessionStreamMd === 'function') disposeSessionStreamMd(sess);
    sess.currentBubbleEl = null;
    sess.pendingToolStarted = false;
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
}
function setBtnSendMode() {
    $(chatSendBtn).removeClass('stop-mode');
    $(chatSendBtn).html('<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>');
    chatSendBtn.title = GourdI18n.t('base.send');
    chatSendBtn.disabled = false;
}

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
    // Go through autoResize uniformly: if there is no manual height, revert to the default min-height; if there is, preserve the height selected by the user
    if (inChatMode) { chatInput.value = ''; autoResize(chatInput); }
    else { welcomeInput.value = ''; autoResize(welcomeInput); }
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
