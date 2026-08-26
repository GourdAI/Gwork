/* ===== app-streaming.js ===== */
/* 通信与核心流程：发送 + WebChunk + WebSocket */
/* 依赖：app-base.js, app-ui.js, app-history.js, app-message.js */

/* ===== Send from both inputs ===== */
$(welcomeSendBtn).on('click', function() { sendMessage(); });
$(chatSendBtn).on('click', function() {
    if (isStreaming && activeSessionId && sessionMap[activeSessionId]) {
        try {
            //提交 interrupt
            $.post('/web/chat/interrupt?sessionId=' + encodeURIComponent(activeSessionId));
        } finally {
            // 停止流
            finishStream(sessionMap[activeSessionId]);
        }
    } else {
        sendMessage();
    }
});

/* ===== Click to focus ===== */
$('.welcome-input-box').on('click', function(e) {
    if (!$(e.target).closest('button').length && !$(e.target).closest('.loop-panel').length) welcomeInput.focus();
});
$('.input-box').on('click', function(e) {
    if (!$(e.target).closest('button').length && !$(e.target).closest('.history-panel').length && !$(e.target).closest('.loop-panel').length && !$(e.target).closest('.todo-float-panel').length) chatInput.focus();
});

/* ===== New Chat ===== */
$(newChatBtn).on('click', function() {
    // code 模式：对话在右栏、中间是编辑器/diff 浮层（二者正交）。
    // 新建会话只应在右栏新开空会话，不得关闭中间 diff，也不得回欢迎页
    // （.welcome-view 在 code 模式被 display:none!important 隐藏，回欢迎页会变空白）。
    if (window.appMode === 'code' && typeof window.startFreshCodeSession === 'function') {
        window.startFreshCodeSession();
        return;
    }
    if (typeof closeDiffViewer === 'function') closeDiffViewer();
    currentChatIndex = -1;
    switchToWelcomeMode();
    updateHistoryUI();
});

/* ===== Send ===== */
function sendMessage() {
    var text = getInputText();
    if (!text && pendingFiles.length === 0) return;
    /* Block only if the active session is currently streaming */
    // 任务执行中或队列有未处理消息，将消息加入队列
    var isBlocked = activeSessionId && sessionMap[activeSessionId] && sessionMap[activeSessionId].isStreaming;
    
    if (isBlocked) {
        // 任务执行中，将消息加入对应会话的队列
        // 注意：排队时附件尚未上传到服务端，队列只保存文本和附件元数据
        // 出队时只发送文本，附件需要用户手动重新上传
        var imageCount = 0, fileCount = 0;
        var imagePaths = [], filePaths = [];
        for (var i = 0; i < pendingFiles.length; i++) {
            if (pendingFiles[i].type === 'image') {
                imageCount++;
                imagePaths.push(pendingFiles[i].name); // 保存文件名作为占位
            } else {
                fileCount++;
                filePaths.push(pendingFiles[i].name);
            }
        }
        
        var queueText = (text && text.trim()) ? text.trim() : '';
        if (!queueText) {
            if (imageCount > 0 && fileCount > 0) {
                queueText = GourdI18n.t('streaming.describe_images') + ' ' + GourdI18n.t('streaming.process_files');
            } else if (imageCount > 0) {
                queueText = GourdI18n.t('streaming.describe_images');
            } else {
                queueText = GourdI18n.t('streaming.process_files');
            }
        }
        
        window.messageQueue.add(activeSessionId, queueText, imagePaths, filePaths).then(function() {
            updateMessageQueueUI();
            clearInput();
            clearAttachmentPreview();
        });
        return;
    }

    var filesToSend = pendingFiles.slice(); // snapshot

    // Build display text
    var displayText = text || '';
    if (!displayText && filesToSend.length > 0) {
        var first = filesToSend[0];
        if (first.attachmentsType === 'image') {
            displayText = GourdI18n.t('streaming.describe_images');
        } else {
            displayText = GourdI18n.t('streaming.process_files');
        }
    }

    if (currentChatIndex === -1) {
        saveChatToHistory(displayText);
    }

    if (!inChatMode) switchToChatMode();
    setActiveSession(SESSION_ID);

    var sess = sessionMap[SESSION_ID];
    // 记录会话所属工作空间根（code=项目 / chat=所选工作空间），供回放/删除/HITL 补发定位用
    sess.projectRoot = (window.appMode === 'code') ? (window.currentProjectRoot || '') : (window.currentChatWorkspace || '');

    // Show user message with attachment previews
    var imageDataUrls = [];
    var fileAttachments = [];
    for (var i = 0; i < filesToSend.length; i++) {
        if (filesToSend[i].type === 'image') imageDataUrls.push(filesToSend[i]);
        else fileAttachments.push(filesToSend[i]);
    }
    appendUserMessage(sess, displayText, imageDataUrls, fileAttachments);

    sess.isStreaming = true;
    isStreaming = true;
    setBtnStopMode();
    resetStreamState(sess);
    showThinking(sess);

    sendWithFormData(sess, text, filesToSend);

    // Clear input & attachment preview AFTER message is rendered and sent,
    // otherwise releaseAttachmentData() would null out dataUrl/file in the
    // shallow-copied filesToSend snapshot (filesToSend = pendingFiles.slice()),
    // causing broken image icons and empty file uploads.
    clearInput();
    clearAttachmentPreview();
}

function sendWithFormData(sess, text, filesToSend) {
    sendWithFormDataGrouped(sess, text, filesToSend);
}

/* ===== 静默发送斜杠命令 =====
   与 sendMessage 不同：不渲染用户气泡（避免出现 "/rerun" 这样的丑斜杠文本），
   只进入流式等待态并发起命令。供最后一条 AI 消息的“重新运行/继续运行”按钮使用。
   onBeforeSend：发起前的同步回调（如清理旧 DOM）。 */
function sendCommandSilent(cmdText, onBeforeSend) {
    if (!activeSessionId || !sessionMap[activeSessionId]) return;
    var sess = sessionMap[activeSessionId];
    /* 流式进行中禁止重复触发 */
    if (sess.isStreaming) return;

    if (typeof onBeforeSend === 'function') {
        try { onBeforeSend(sess); } catch (e) {}
    }

    if (!inChatMode) switchToChatMode();
    setActiveSession(sess.sessionId);

    sess.isStreaming = true;
    isStreaming = true;
    setBtnStopMode();
    resetStreamState(sess);
    showThinking(sess);

    sendWithFormDataGrouped(sess, cmdText, []);
}
window.sendCommandSilent = sendCommandSilent;

function sendWithFormDataGrouped(sess, text, filesToSend) {
    // 用户主动发起会话：确保底层 WebSocket 就绪（可能仍在启动或退避已耗尽）
    if (typeof ensureWebGateConnected === 'function') ensureWebGateConnected();
    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }
    var model = getSelectedModel();
    var formData = new FormData();
    formData.append('input', text);
    formData.append('sessionId', sess.sessionId);
    if (model) formData.append('model', model);
    for (var i = 0; i < filesToSend.length; i++) {
        formData.append('attachments', filesToSend[i].file, filesToSend[i].name);
        formData.append('attachmentTypes', filesToSend[i].attachmentsType || 'file');
    }

    // 标记流式状态，WebSocket onmessage 会处理数据
    sess.isStreaming = true;
    if (sess.sessionId === activeSessionId) {
        isStreaming = true;
        setBtnStopMode();
    }
    resetStreamState(sess);
    showThinking(sess);

    $.ajax({
        url: SSE_ENDPOINT,
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        headers: (typeof getSessionCwd === 'function' && getSessionCwd())
            ? { 'X-Session-Cwd': getSessionCwd() } : {}
    }).done(function(resp) {
        // 正常响应为 {"code":200}；若服务端判定会话繁忙（上一条任务未结束的重复触发），
        // 返回 data="busy"：前端暂存本条消息，待当前任务的 done 到达后自动补发，
        // 避免并行两个 ReAct 循环的 chunk 交错导致思考/正文错位
        var st = resp;
        if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
        if (st && st.data === 'busy') {
            handleSendBusy(sess, text);
        }
    }).fail(function(err) {
        console.error('Send error:', err);
        var errMsg = GourdI18n.t('streaming.send_failed');
        if (typeof showToast === 'function') {
            showToast(errMsg, 'error');
        }
        finishStream(sess);
    });
}

/* ===== 服务端繁忙（busy）处理 =====
   服务端对“会话已有任务在执行”的重复触发会跳过并返回 busy。
   前端此处收尾本地流状态，并暂存本条消息（非斜杠命令），
   待当前任务的 done 块到达后自动补发（不重复渲染用户气泡），确保消息不丢失。 */
function handleSendBusy(sess, text) {
    console.warn('[WebGate] server busy, message deferred for session:', sess.sessionId);
    var t = (text && text.trim()) ? text.trim() : '';
    if (t && t.charAt(0) !== '/') {
        sess._pendingResend = t;
    }
    if (typeof showToast === 'function') {
        showToast(GourdI18n.t('streaming.busy_deferred'), 'warning');
    }
    finishStream(sess);
}

/* ===== WebChunk Handling (Session-Aware) ===== */
function onWebChunk(sess, chunk) {
    try {
        if (sess.silenceTimer) {
            clearTimeout(sess.silenceTimer);
        }

        removeInlineThinking(sess);

        // 存储当前 chunk 的 runId，用于后续消息渲染
        if (chunk.runId) {
            sess.currentRunId = chunk.runId;
        }

        switch (chunk.type) {
            case 'command': finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); appendCommandOutput(sess, chunk.text); break;
            case 'rewind': finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); handleRewind(sess, parseInt(chunk.text) || 1); break;
            case 'reason': finishPendingTool(sess); clearRetryChunk(sess);
                // 归属路由：chunk.args.agentName 指向活跃智能体卡片时进卡片内，否则归主对话
                var reasonOwner = resolveAgentState(sess, chunk.args);
                if (reasonOwner) {
                    appendAgentReasonChunk(sess, chunk.text, reasonOwner);
                } else {
                    appendReasonChunk(sess, chunk.text);
                }
                break;
            case 'text':   finishThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess);
                var textOwner = resolveAgentState(sess, chunk.args);
                // 归属智能体开始输出正文时，只结束其自己的思考块（并行其他智能体的思考块不受影响）
                if (textOwner) finishAgentThinkingBlock(sess, textOwner);
                if (textOwner) {
                    // 子代理正文（task 单任务增量 / multitask 各任务结果）：渲染进智能体卡片
                    appendAgentBodyContent(sess, chunk.text, textOwner);
                } else {
                    appendContentChunk(sess, chunk.text, true);
                }
                break;
            case 'action_end': finishThinkingBlock(sess); clearRetryChunk(sess);
                var endOwnerState = resolveAgentState(sess, chunk.args);
                if (endOwnerState) { finishAgentThinkingBlock(sess, endOwnerState); }
                appendActionEndChunk(sess, chunk.toolName, chunk.text, chunk.args, chunk.toolTitle, chunk.actionId, chunk.truncated ? { truncated: true, seq: chunk.seq, fullLength: chunk.fullLength } : null, endOwnerState ? endOwnerState.bodyEl : null);
                if (window._todoChunkHandlers) window._todoChunkHandlers.forEach(function(h){h(chunk);});
                break;
            case 'action_start': finishThinkingBlock(sess); clearRetryChunk(sess);
                var startOwnerState = resolveAgentState(sess, chunk.args);
                if (startOwnerState) { finishAgentThinkingBlock(sess, startOwnerState); }
                appendActionStartChunk(sess, chunk.toolName, chunk.args, chunk.toolTitle, chunk.actionId, startOwnerState ? startOwnerState.bodyEl : null);
                break;
            case 'agent':  finishThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess);
                var agentOwner = resolveAgentState(sess, chunk.args);
                if (agentOwner) finishAgentThinkingBlock(sess, agentOwner);
                if (agentOwner || sess._agentStateLast) {
                    appendAgentBodyContent(sess, chunk.text, agentOwner);
                } else {
                    appendContentChunk(sess, chunk.text, false);
                }
                break;
            case 'agent_start': finishThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendAgentBadge(sess, chunk, true); break;
            case 'agent_end': finishThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendAgentBadge(sess, chunk, false); break;
            case 'error':  finishThinkingBlock(sess); finishAgentThinkingBlock(sess); clearRetryChunk(sess); if (typeof markToolCardFailed === 'function') markToolCardFailed(sess);
                // 统一以红色错误块渲染，不再写入智能体卡片体：
                // 后端 WebChunk.ofError 不携带 sessionId/agentName，无法可靠归属；
                // 若写入某智能体卡，错误会被当作该智能体的正常正文渲染（误导），
                // 且并行多智能体时归属无从选择。主对话错误块是唯一可靠位置。
                appendErrorChunk(sess, chunk.text);
                break;
            case 'retry':  finishThinkingBlock(sess); finishPendingTool(sess);
                // 后端不会转发子代理的 RetryChunk（TaskTalent 只转发 ContextUsage/Action/Observation/Reason/Thought），
                // 故 retry 恒为主代理事件；且 WebChunk.ofRetry 不携带 agentName，无法归属，
                // 始终在主对话展示重试提示（下一 chunk 到达时自动清除），不得写入智能体卡片体
                appendRetryChunk(sess, chunk.text);
                break;
            case 'hitl':   finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); appendHitlCard(sess, chunk.toolName, chunk.command); break;
            case 'trace':  finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); appendTraceBadge(sess, chunk); break;
            case 'context_size':
                // 快照始终写入会话（即使非活跃），保证切回该会话时能恢复；仅活跃会话刷新 DOM。
                // 两分支均遵循单调时间戳门禁（回放旧帧不得覆盖新帧）
                if (typeof updateContextIndicator === 'function') {
                    if (sess.sessionId === activeSessionId) {
                        updateContextIndicator(chunk, sess);
                    } else if (!sess.lastContextChunk
                            || (chunk.createdAt || 0) >= (sess.lastContextChunk.createdAt || 0)) {
                        sess.lastContextChunk = chunk;
                    }
                }
                break;
        }
        sess.silenceTimer = setTimeout(function() {
            if (!sess.isStreaming || sess.thinkingBlockEl) return;
            // 存在活跃子智能体卡片时：运行中状态由卡片头部状态标识闪烁表示，
            // 不在主气泡底部显示全局指示器——多智能体并行时全局指示器归属不明（跑到卡片外）
            if (sess.agentStates && Object.keys(sess.agentStates).length > 0) return;
            showInlineThinking(sess);
        }, 1000);
        // 回放态：纯历史重建，不应触发「思考中」等待指示器（它依赖真实的流间隙）
        if (sess._replaying && sess.silenceTimer) { clearTimeout(sess.silenceTimer); sess.silenceTimer = null; }
    } catch (e) {}
}

function finishStream(sess) {
    var wasStreaming = sess.isStreaming;
    sess.isStreaming = false;
    if (sess.silenceTimer) { clearTimeout(sess.silenceTimer); sess.silenceTimer = null; }

    // 清除可能残留的重试提示（如所有重试失败、最终错误已作为答复展示）
    if (typeof clearRetryChunk === 'function') clearRetryChunk(sess);

    // --- 新增：强刷逻辑，必须在 resetStreamState 之前执行 ---
    // 1. 增量渲染器的 finish() 内部会取消还没跑的动画帧

    // 2. 立即把 Buffer 内容渲染出来（此时是最终态，执行完整高亮/mermaid）
    if (sess.reasonBuffer) {
        var el = ensureAssistantBubble(sess);
        el.setAttribute('data-md-raw', sess.reasonBuffer);
        getStreamMd(el).finish();
        if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(el);
        // 流结束时再做一次性高亮，避免流式中逐帧高亮引起的跳动
        if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(el);
        // mermaid 异步渲染，不会引起同步布局跳动
        if (typeof processMermaidBlocks === 'function') processMermaidBlocks(el);
    }
    // 如果有思考中的内容，也刷一下
    if (sess.thinkingBlockEl && sess.thinkingBuffer) {
        if (sess.thinkingBodyMdEl) {
            getStreamMd(sess.thinkingBodyMdEl).finish();
            if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(sess.thinkingBodyMdEl);
            if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(sess.thinkingBodyMdEl);
            if (typeof processMermaidBlocks === 'function') processMermaidBlocks(sess.thinkingBodyMdEl);
        }
    }
    // ---------------------------------------------------

    removeThinking(sess);
    purgeInlineThinking(sess);
    finishThinkingBlock(sess);
    finishAgentThinkingBlock(sess);
    finishPendingTool(sess);

    // 修复：确保所有工具卡片的状态图标都更新为完成状态
    // 查找当前会话容器中所有处于 loading 状态的工具卡片和智能体状态点
    if (sess.container) {
        $(sess.container).find('.tool-status-icon.loading').each(function() {
            this.className = 'tool-status-icon done';
            this.innerHTML = '';
        });
        // 同时清理残留的 loading 态子智能体状态点
        $(sess.container).find('.agent-status-icon.loading').each(function() {
            this.className = 'agent-status-icon done';
        });
        // 移除残留的 .agent-card-streaming 类
        $(sess.container).find('.agent-card-streaming').removeClass('agent-card-streaming');
        // 移除残留的 .streaming 思考块标记
        $(sess.container).find('.thinking-block.streaming').removeClass('streaming');
    }

    sess.approvedToolCard = null;

    // 收尾批量分组状态：把仍在 loading 的分组头部转完成态（纯色绿点，不放内部图标），并清空 id 卡片表，避免残留跨轮
    if (sess.currentBatch && sess.currentBatch.groupEl) {
        var bIcon = $(sess.currentBatch.groupEl).find('.tool-batch-header .tool-status-icon.loading')[0];
        if (bIcon) { bIcon.className = 'tool-status-icon done'; bIcon.innerHTML = ''; }
    }
    sess.currentBatch = null;
    sess.toolCardsById = {};

    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }

    // 显示助手消息时间戳
    setAssistantTime(sess, sess._lastCreatedAt || Date.now());
    sess._lastCreatedAt = null;

    // 流式结束，显示复制按钮（流式过程中被隐藏）
    if (sess.currentBubbleEl) {
        var doneRow = $(sess.currentBubbleEl).closest('.msg-row')[0];
        if (doneRow) $(doneRow).find('.msg-actions').show();
    }

    // resetStreamState 会清空 buffer，所以必须在上面强刷完后再调
    resetStreamState(sess);

    // 清扫遗留的视觉为空正文容器，统一卡片间隔（指针推进遗留的空 .md-content 会撑出参差间距）
    purgeEmptyMdBlocks(sess.container);

    if (sess.sessionId === activeSessionId) {
        isStreaming = false;
        setBtnSendMode();
        // 只有在活动会话才滚动；回放收尾（_skipScroll）时由回放层自行控制滚动
        if (!sess._skipScroll) scrollToBottom(true);
        chatInput.focus();
    }

    // 刷新侧边栏，清除该会话的 spinner
    if (typeof updateHistoryUI === 'function') updateHistoryUI();

    // 刷新任务面板
    if (window.loadTodos) window.loadTodos();
    
    // 任务完成，自动处理当前会话的消息队列
    if (sess && sess.sessionId && window.messageQueue) {
        window.messageQueue.size(sess.sessionId).then(function(qSize) {
            if (qSize > 0) {
                setTimeout(function() {
                    processMessageQueue(sess.sessionId);
                }, 500);
            }
        });
    }

}

/* ===== WebSocket 单连接 ===== */
var webGateSocket = null;
var webGateReconnectAttempts = 0;
var webGateHeartbeatTimer = null;
// 重复推送去重的指纹滑窗（最近 N 条；相邻与交错到达的重复帧均可命中；
// 旧版单变量 lastGateFp 仅能去重相邻同帧，双连接非相邻送达的重复帧会漏网）
var GATE_FP_WINDOW = 200;
var gateFpQueue = [];
var gateFpSet = {};
function gateFpSeen(fp) {
    if (gateFpSet[fp]) return true;
    gateFpSet[fp] = true;
    gateFpQueue.push(fp);
    if (gateFpQueue.length > GATE_FP_WINDOW) delete gateFpSet[gateFpQueue.shift()];
    return false;
}
var WEBGATE_MAX_RECONNECT = 10;

// 用户主动发起会话时确保连接就绪：若连接已断且退避已停止，则重置计数并立即重连。
function ensureWebGateConnected() {
    if (webGateSocket &&
        (webGateSocket.readyState === WebSocket.OPEN || webGateSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    webGateReconnectAttempts = 0;
    connectWebGate();
}
window.ensureWebGateConnected = ensureWebGateConnected;

// 连接断开时：不弹顶部横幅。仅当有会话正在流式输出时，在该对话里就地提示
// （与普通对话异常同款的红色错误），并结束其流。空闲/启动阶段没有流式会话，则完全静默。
function notifyStreamingSessionsDisconnected() {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var sess = sessionMap[sid];
        if (sess && sess.isStreaming) {
            if (typeof appendErrorChunk === 'function') appendErrorChunk(sess, GourdI18n.t('streaming.connection_disconnected'));
            finishStream(sess);
        }
    }
}

function connectWebGate() {
    // 已连接或正在连接则跳过，避免重复建连。
    // （桌面端就绪时 __whenBackendReady 与 onBackendReady 会同一时刻各触发一次，
    //   此刻 socket 处于 CONNECTING 而非 OPEN，必须一并拦住，否则会建出两个连接。）
    if (webGateSocket &&
        (webGateSocket.readyState === WebSocket.OPEN || webGateSocket.readyState === WebSocket.CONNECTING)) return;
    // 退役 CLOSING/CLOSED 的旧连接：先摘掉全部回调再 close，杜绝新旧连接并存期间
    // 旧连接继续收帧造成重复推送、或旧 onclose 误终结新连接的流。
    if (webGateSocket) {
        try {
            webGateSocket.onopen = null;
            webGateSocket.onmessage = null;
            webGateSocket.onclose = null;
            webGateSocket.onerror = null;
            webGateSocket.close();
        } catch (e) { /* 退役异常忽略 */ }
        webGateSocket = null;
    }
    try {
        // 同源 WebSocket：
        // - 浏览器模式（gwork web 0）：直连 jar 自身。
        // - 桌面端（Electron）：页面来自本地 UI 服务器 http://localhost:{uiPort}，
        //   该服务器把 /web/gate 反向代理到后端 jar，故同样用同源地址即可。
        var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        var wsUrl = protocol + '//' + window.location.host + '/web/gate';
        webGateSocket = new WebSocket(wsUrl);
    } catch(e) {
        console.error('[WebGate] create failed:', e);
        scheduleWebGateReconnect();
        return;
    }

    webGateSocket.onopen = function() {
        console.log('[WebGate] connected');
        webGateReconnectAttempts = 0;
        startWebGateHeartbeat();
        // 重连后刷新文件树
        if (typeof loadTree === 'function') {
            loadTree();
        }
    };

    webGateSocket.onmessage = function(event) {
        // 被退役旧连接的残帧直接丢弃（新旧连接并存的重复推送残留通路）
        if (event.target && webGateSocket && event.target !== webGateSocket) return;
        var raw = event.data;
        if (raw === 'pong') return; // 心跳回复
        try {
            var chunk = JSON.parse(raw);

            // 重复推送兜底去重：多连接并存时同一事件可能送达两次（payload 完全一致），
            // 滑窗内重复帧丢弃（相邻与交错重复均覆盖）；仅带 createdAt 的业务帧参与，心跳/系统帧原样放行。
            if (chunk && chunk.createdAt) {
                var fp = (chunk.type || '') + '\u0001' + (chunk.sessionId || '') + '\u0001' + chunk.createdAt + '\u0001' + raw;
                if (gateFpSeen(fp)) return;
            }

            // 回放/实时互斥门禁：会话处于历史回放中或等待回放响应期间，同会话实时帧（含 user/done）
            // 先入缓冲队列，由 replayDone/加载完成统一去重喂入（drainGateBuffer），避免同一事件被
            // 回放快照与实时流两条管线各渲染一次；回放结束后快照覆盖集继续生效（至本轮 done），拦截迟到的快照内帧。
            var gateSess = chunk.sessionId ? sessionMap[chunk.sessionId] : null;
            if (gateSess && (gateSess._replaying || gateSess._gateBuffering)) {
                gateSess._gateBuffer.push(chunk);
                return;
            }
            if (gateSess && gateSess._replayCoverage && replayCoverageHas(gateSess._replayCoverage, chunk)) return;

            dispatchGateChunk(chunk);
        } catch(e) {
            // 非 JSON 消息忽略
        }
    };

    webGateSocket.onclose = function() {
        console.log('[WebGate] closed');
        stopWebGateHeartbeat();
        // 不弹顶部横幅：仅当有会话正在流式输出时，在对话内就地提示异常
        notifyStreamingSessionsDisconnected();
        scheduleWebGateReconnect();
    };

    webGateSocket.onerror = function(err) {
        console.error('[WebGate] error:', err);
    };
}

/* gate 帧业务分发体（模块级全局：onmessage 与 app-history.js 的 drainGateBuffer 回放缓冲排空共用） */
function dispatchGateChunk(chunk) {
    var sid = chunk.sessionId;

    // WebSocket 流结束信号
    if (chunk.type === 'done') {
        if (!sid) return;
        var sess = sessionMap[sid];
        if (!sess) return;
        // 保存 done 消息的时间戳，用于 finishStream 显示
        if (chunk.createdAt) sess._lastCreatedAt = chunk.createdAt;
        // 本轮结束：清除回放快照覆盖集（使命完成，避免误拦后续轮次帧）
        sess._replayCoverage = null;
        finishStream(sess);
        // busy 暂存的消息：当前任务已结束，延迟补发（不重复渲染用户气泡）。
        // 延迟 300ms 避开 finishStream 内部的队列处理时序；若期间用户已手动发送则跳过。
        if (sess._pendingResend) {
            var pr = sess._pendingResend;
            sess._pendingResend = null;
            setTimeout(function() {
                var s2 = sessionMap[sid];
                if (!s2 || s2.isStreaming) return;
                sendWithFormDataGrouped(s2, pr, []);
            }, 300);
        }
        return;
    }

    // 文件变更通知（无 sessionId，系统级广播）
    if (chunk.type === 'filer_change') {
        if (typeof onFilerChange === 'function') {
            onFilerChange(chunk);
        }
        return;
    }

    if (!sid) return; // 无 sessionId 的消息丢弃

    // 即使 sess2 不存在，也优先处理 todowrite 动作（用于更新左侧 Sidebar 的 todo 进度）
    if (chunk.type === 'action_end' && chunk.toolName === 'todowrite') {
        if (window._todoChunkHandlers) {
            window._todoChunkHandlers.forEach(function(h) { h(chunk); });
        }
    }

    // Loop/微信 等后端推送的用户提示词，先渲染用户消息气泡
    if (chunk.type === 'user_input' || chunk.type === 'user') {
        if (!sid) return;
        var userSess = getOrCreateSession(sid);
        if (typeof ensureChatInHistory === 'function') {
            // Loop 定时任务执行记录：按任务归属工作空间（chunk.root）静默登记，
            // 不切换 tab / 不抢焦点，避免打扰用户当前视图；其它来源（微信等）保持原联动语义
            if (chunk.type === 'user_input' && chunk.toolName === 'Loop') {
                ensureChatInHistory(sid, chunk.text, false, { root: chunk.root || '', silent: true, loop: true });
            } else {
                ensureChatInHistory(sid, chunk.text, true);
            }
        }
        appendUserMessage(userSess, chunk.text, null, null, chunk.createdAt);
        if (userSess.sessionId === activeSessionId) {
            if (!inChatMode) switchToChatMode();
            scrollToBottom(true);
        }
        return;
    }

    var sess2 = getOrCreateSession(sid);
    if (!sess2.isStreaming) {
        sess2.isStreaming = true;
        if (sess2.sessionId === activeSessionId) {
            isStreaming = true;
            setBtnStopMode();
            if (!inChatMode) switchToChatMode();
        }
        resetStreamState(sess2);
        showThinking(sess2);
    }
    onWebChunk(sess2, chunk);
}

function startWebGateHeartbeat() {
    stopWebGateHeartbeat();
    webGateHeartbeatTimer = setInterval(function() {
        if (webGateSocket && webGateSocket.readyState === WebSocket.OPEN) {
            webGateSocket.send('ping');
        }
    }, 15000);
}

function stopWebGateHeartbeat() {
    if (webGateHeartbeatTimer) {
        clearInterval(webGateHeartbeatTimer);
        webGateHeartbeatTimer = null;
    }
}

function scheduleWebGateReconnect() {
    if (webGateReconnectAttempts >= WEBGATE_MAX_RECONNECT) {
        console.warn('[WebGate] max reconnect attempts reached');
        return;
    }
    var delay = Math.min(1000 * Math.pow(2, webGateReconnectAttempts), 30000);
    webGateReconnectAttempts++;
    console.log('[WebGate] reconnecting in ' + delay + 'ms (attempt ' + webGateReconnectAttempts + ')');
    // 静默后台重连，不弹横幅
    setTimeout(function() {
        connectWebGate();
    }, delay);
}

// 心跳常驻：隐藏/被遮挡时停心跳会让长任务期间的 WS 被空闲断开，
// 回前台后陷入"界面不动、结尾补画"的半死状态；15s 一次 ping 开销可忽略。
$(document).on('visibilitychange', function() {
    if (!document.hidden) {
        startWebGateHeartbeat();
    }
});

// 页面加载后建立 WebSocket 连接。
// 桌面端等后端就绪再连（冷启动期直连会立即 503 并进入退避，白等一轮）；浏览器端立即连。
__whenBackendReady(connectWebGate);

// 桌面端（Electron）：后端就绪/失败由主进程经 IPC 通知。
// 浏览器端 __GOURD_IPC__ 不存在，此块自动跳过。
if (window.__GOURD_IPC__) {
    // 就绪后立即（重）连 WebSocket，并重置退避计数。
    // 启动期的数据请求已由各模块经 __whenBackendReady 延后到此刻发出，不再依赖代理挂起。
    window.__GOURD_IPC__.onBackendReady(function() {
        webGateReconnectAttempts = 0;
        connectWebGate();
    });
    // 启动失败：仅在有流式会话时就地提示，否则静默（外壳仍可用，便于查看日志/重试）。
    window.__GOURD_IPC__.onBackendFailed(function(data) {
        var msg = (data && data.message) ? data.message : GourdI18n.t('streaming.unknown_error');
        for (var sid in sessionMap) {
            if (!sessionMap.hasOwnProperty(sid)) continue;
            var sess = sessionMap[sid];
            if (sess && sess.isStreaming) {
                if (typeof appendErrorChunk === 'function') appendErrorChunk(sess, GourdI18n.t('streaming.backend_start_failed') + msg);
                finishStream(sess);
            }
        }
    });
}

/* ===== WeChat ClawBot Channel ===== */
var wechatHeaderBtn = $('#wechatHeaderBtn');
var wechatHeaderLabel = $('#wechatHeaderLabel');
var wechatModalOverlay = null;
var wechatPollTimer = null;

function updateWechatUI() {
    if (!activeSessionId) return;
    $.get('/web/chat/wechat/status?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
        try {
            var bound = resp.data && resp.data.bound;
            wechatHeaderBtn.toggleClass('bound', !!bound);
            wechatHeaderLabel.text(bound ? GourdI18n.t('streaming.connected') : '');
            wechatHeaderBtn.attr('title', bound ? GourdI18n.t('streaming.wechat_bound') : GourdI18n.t('streaming.wechat_bind'));
        } catch(e) {}
    }, 'json');
}

// Page load & session switch: refresh all IM status
updateWechatUI();
updateFeishuUI();
updateDingTalkUI();
var origSetActiveSession = setActiveSession;
var _sessionSwitchTimer = null;
setActiveSession = function(sid) {
    origSetActiveSession(sid);
    if (_sessionSwitchTimer) {
        clearTimeout(_sessionSwitchTimer);
    }
    // 将非关键请求延迟到下一帧执行，让 UI 先完成切换
    _sessionSwitchTimer = setTimeout(function() {
        _sessionSwitchTimer = null;
        updateWechatUI();
        updateFeishuUI();
        updateDingTalkUI();
        // 切换会话时刷新任务面板
        if (window.loadTodos) window.loadTodos();
        // 切换会话时刷新消息队列 UI（列表/chip/badge）
        if (window.updateMessageQueueUI) window.updateMessageQueueUI();
        // 注：上下文指示器的恢复已由 setActiveSession 内部单点完成（app-base.js），
        // 此处不再重复调用：同 tick 内若会话已被删除，sessionMap[sid] 为 undefined 会误隐藏。
    }, 0);
};

wechatHeaderBtn.on('click', function() {
    if (!activeSessionId) return;
    // If already bound, unbind
    if (wechatHeaderBtn.hasClass('bound')) {
        layConfirm(GourdI18n.t('streaming.wechat_unbind_confirm'), function() {
            $.post('/web/chat/wechat/unbind?sessionId=' + encodeURIComponent(activeSessionId)).always(function() {
                updateWechatUI();
            });
        });
        return;
    }
    // Not bound: show QR modal
    showWechatModal();
});

function showWechatModal() {
    if (wechatModalOverlay) return;

    wechatModalOverlay = $('<div>').addClass('wechat-modal-overlay').html(
        '<div class="wechat-modal">'
        + '<div class="wechat-modal-title">' + GourdI18n.t('streaming.wechat_qr_title') + '</div>'
        + '<div class="wechat-modal-subtitle">' + GourdI18n.t('streaming.wechat_qr_subtitle') + '</div>'
        + '<div class="wechat-qr-wrap" id="wechatQrWrap"><span style="color:#999;font-size:13px">' + GourdI18n.t('streaming.loading') + '</span></div>'
        + '<div class="wechat-status" id="wechatQrStatus">' + GourdI18n.t('streaming.waiting_for_scan') + '</div>'
        + '<button class="wechat-modal-close" id="wechatModalClose">' + GourdI18n.t('streaming.cancel') + '</button>'
        + '</div>'
    );
    $('body').append(wechatModalOverlay);

    $('#wechatModalClose').on('click', closeWechatModal);
    wechatModalOverlay.on('click', function(e) {
        if ($(e.target).is(wechatModalOverlay)) closeWechatModal();
    });

    // Fetch QR code
    $.get('/web/chat/wechat/qrcode?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
        try {
            if (resp.code !== 200 || !resp.data) {
                $('#wechatQrStatus').text(resp.message || GourdI18n.t('streaming.qr_fetch_failed')).addClass('error');
                return;
            }
            var $qrWrap = $('#wechatQrWrap');
            $qrWrap.html('');
            var qrContent = resp.data.qrcode_img_content || resp.data.qrcode;
            if (qrContent) {
                try {
                    new QRCode($qrWrap[0], { text: qrContent, width: 180, height: 180 });
                } catch(e) {
                    $qrWrap.html('<span style="font-size:12px;color:#666;padding:10px">' + escapeHtml(qrContent) + '</span>');
                }
            }
            // Start polling
            startWechatPoll(resp.data.qrcode, activeSessionId);
        } catch(e) {
            $('#wechatQrStatus').text(GourdI18n.t('streaming.parse_failed')).addClass('error');
        }
    }, 'json');
}

function startWechatPoll(qrcode, sessionId) {
    if (wechatPollTimer) clearInterval(wechatPollTimer);
    wechatPollTimer = setInterval(function() {
        $.get('/web/chat/wechat/qrcode/status?qrcode=' + encodeURIComponent(qrcode) + '&sessionId=' + encodeURIComponent(sessionId), function(resp) {
            try {
                var data = resp.data || {};
                var $statusEl = $('#wechatQrStatus');
                if (!$statusEl.length) return;

                var status = data.status;
                if (status === 'wait') {
                    $statusEl.text(GourdI18n.t('streaming.waiting_for_scan')).removeClass('error scanned');
                } else if (status === 'scaned') {
                    $statusEl.text(GourdI18n.t('streaming.wechat_scan_confirm')).removeClass('error').addClass('scanned');
                } else if (status === 'confirmed') {
                    $statusEl.text(GourdI18n.t('streaming.connection_success')).removeClass('error').addClass('scanned');
                    clearInterval(wechatPollTimer);
                    wechatPollTimer = null;
                    setTimeout(function() {
                        closeWechatModal();
                        updateWechatUI();
                        switchToChatMode();
                        var initSess = getOrCreateSession(SESSION_ID);
                        if (!initSess._wechatInited) {
                            initSess._wechatInited = true;
                            appendSystemNotice(initSess, GourdI18n.t('streaming.wechat_connected_notice'));
                        }
                    }, 1200);
                } else if (status === 'expired') {
                    $statusEl.text(GourdI18n.t('streaming.qr_expired')).removeClass('scanned').addClass('error');
                    clearInterval(wechatPollTimer);
                    wechatPollTimer = null;
                } else {
                    // 临时错误或未知状态：继续轮询，扫码过程中的API短暂波动不应打断流程
                    if (wechatPollTimer) {
                        $statusEl.text(GourdI18n.t('streaming.scan_processing')).removeClass('error scanned');
                    }
                }
            } catch(e) {}
        }, 'json');
    }, 2000);
}

function closeWechatModal() {
    if (wechatPollTimer) { clearInterval(wechatPollTimer); wechatPollTimer = null; }
    if (wechatModalOverlay) {
        wechatModalOverlay.remove();
        wechatModalOverlay = null;
    }
}

/* ===== Feishu Channel ===== */
var feishuHeaderBtn = $('#feishuHeaderBtn');
var feishuHeaderLabel = $('#feishuHeaderLabel');
var feishuModalOverlay = null;
var feishuPollTimer = null;

function updateFeishuUI() {
    if (!activeSessionId) return;
    $.get('/web/chat/feishu/status?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
        try {
            var data = resp.data || {};
            var bound = !!data.bound;
            feishuHeaderBtn.toggleClass('bound', bound);
            feishuHeaderLabel.text(bound ? GourdI18n.t('streaming.connected') : '');
            feishuHeaderBtn.attr('title', bound ? GourdI18n.t('streaming.feishu_bound') : GourdI18n.t('streaming.feishu_bind'));
        } catch(e) {}
    }, 'json');
}

// Page load: refresh status
updateFeishuUI();

feishuHeaderBtn.on('click', function() {
    if (!activeSessionId) return;
    // If already bound, unbind
    if (feishuHeaderBtn.hasClass('bound')) {
        layConfirm(GourdI18n.t('streaming.feishu_unbind_confirm'), function() {
            $.post('/web/chat/feishu/unbind?sessionId=' + encodeURIComponent(activeSessionId)).always(function() {
                updateFeishuUI();
            });
        });
        return;
    }
    // Not bound: show bind modal
    showFeishuModal();
});

function showFeishuModal() {
    if (feishuModalOverlay) return;

    feishuModalOverlay = $('<div>').addClass('im-bind-modal-overlay').html(
        '<div class="im-bind-modal">'
        + '<div class="im-bind-modal-title" style="color:#3370ff">' + GourdI18n.t('streaming.feishu_bind') + '</div>'
        + '<div class="im-bind-modal-subtitle">' + GourdI18n.t('streaming.feishu_bind_subtitle') + '</div>'
        + '<div class="im-bind-input-group">'
        + '  <label class="im-bind-input-label">' + GourdI18n.t('streaming.feishu_app_id') + '</label>'
        + '  <input class="im-bind-input" id="feishuAppIdInput" placeholder="' + GourdI18n.t('streaming.feishu_app_id_placeholder') + '" />'
        + '</div>'
        + '<div class="im-bind-input-group">'
        + '  <label class="im-bind-input-label">' + GourdI18n.t('streaming.feishu_app_secret') + '</label>'
        + '  <input class="im-bind-input" id="feishuAppSecretInput" type="password" placeholder="' + GourdI18n.t('streaming.feishu_app_secret_placeholder') + '" />'
        + '</div>'
        + '<div class="im-bind-status" id="feishuBindStatus">&nbsp;</div>'
        + '<button class="im-bind-confirm-btn feishu" id="feishuBindConfirmBtn">' + GourdI18n.t('streaming.connect') + '</button>'
        + '<button class="im-bind-modal-close" id="feishuModalClose">' + GourdI18n.t('streaming.cancel') + '</button>'
        + '<div class="im-bind-hint">' + GourdI18n.t('streaming.feishu_bind_hint') + '</div>'
        + '</div>'
    );
    $('body').append(feishuModalOverlay);

    $('#feishuModalClose').on('click', closeFeishuModal);
    feishuModalOverlay.on('click', function(e) {
        if ($(e.target).is(feishuModalOverlay)) closeFeishuModal();
    });

    var $appIdInput = $('#feishuAppIdInput');
    var $appSecretInput = $('#feishuAppSecretInput');
    var $statusEl = $('#feishuBindStatus');
    var $confirmBtn = $('#feishuBindConfirmBtn');

    $appIdInput.focus();

    $confirmBtn.on('click', function() {
        var appId = $appIdInput.val().trim();
        var appSecret = $appSecretInput.val().trim();
        if (!appId) {
            $statusEl.text(GourdI18n.t('streaming.feishu_enter_app_id')).addClass('error');
            return;
        }
        if (!appSecret) {
            $statusEl.text(GourdI18n.t('streaming.feishu_enter_app_secret')).addClass('error');
            return;
        }
        $statusEl.text(GourdI18n.t('streaming.feishu_starting_connection')).removeClass('error scanned');
        $confirmBtn.prop('disabled', true);
        $appIdInput.prop('disabled', true);
        $appSecretInput.prop('disabled', true);

        var params = 'sessionId=' + encodeURIComponent(activeSessionId)
            + '&appId=' + encodeURIComponent(appId)
            + '&appSecret=' + encodeURIComponent(appSecret);

        $.ajax({
            url: '/web/chat/feishu/bind?' + params,
            method: 'POST',
            dataType: 'json'
        }).done(function(resp) {
            if (resp.code === 200) {
                // WebSocket 启动成功，进入等待飞书消息状态
                $statusEl.text(GourdI18n.t('streaming.feishu_connection_success')).removeClass('error');
                $confirmBtn.hide();
                // 开始轮询绑定状态
                startFeishuPoll();
            } else {
                $statusEl.text(resp.message || GourdI18n.t('streaming.connection_failed')).addClass('error');
                $confirmBtn.prop('disabled', false);
                $appIdInput.prop('disabled', false);
                $appSecretInput.prop('disabled', false);
            }
        }).fail(function(jqXhr) {
            if (jqXhr.status) {
                $statusEl.text(GourdI18n.t('streaming.request_failed') + ' (' + jqXhr.status + ')').addClass('error');
            } else {
                $statusEl.text(GourdI18n.t('streaming.connection_failed')).addClass('error');
            }
            $confirmBtn.prop('disabled', false);
            $appIdInput.prop('disabled', false);
            $appSecretInput.prop('disabled', false);
        });
    });

    function startFeishuPoll() {
        if (feishuPollTimer) clearInterval(feishuPollTimer);
        var dotCount = 0;
        feishuPollTimer = setInterval(function() {
            dotCount = (dotCount + 1) % 4;
            var dots = '.'.repeat(dotCount);
            $statusEl.text(GourdI18n.t('streaming.waiting_for_feishu_message') + dots);

            $.get('/web/chat/feishu/status?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
                try {
                    var data = resp.data || {};
                    if (data.bound) {
                        // 绑定成功！
                        clearInterval(feishuPollTimer);
                        feishuPollTimer = null;
                        $statusEl.text(GourdI18n.t('streaming.bind_success')).removeClass('error').addClass('scanned');
                        setTimeout(function() {
                            closeFeishuModal();
                            updateFeishuUI();
                            switchToChatMode();
                        }, 1000);
                    }
                } catch(e) {}
            }, 'json');
        }, 2000);
    }

    // Enter key to confirm
    $appIdInput.add($appSecretInput).on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $confirmBtn.click();
        }
    });
}

function closeFeishuModal() {
    if (feishuPollTimer) {
        clearInterval(feishuPollTimer);
        feishuPollTimer = null;
    }
    if (feishuModalOverlay) {
        feishuModalOverlay.remove();
        feishuModalOverlay = null;
    }
}

/* ===== DingTalk Channel ===== */
var dingtalkHeaderBtn = $('#dingtalkHeaderBtn');
var dingtalkHeaderLabel = $('#dingtalkHeaderLabel');
var dingtalkModalOverlay = null;
var dingtalkPollTimer = null;

function updateDingTalkUI() {
    if (!activeSessionId) return;
    $.get('/web/chat/dingtalk/status?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
        try {
            var data = resp.data || {};
            var bound = !!data.bound;
            dingtalkHeaderBtn.toggleClass('bound', bound);
            dingtalkHeaderLabel.text(bound ? GourdI18n.t('streaming.connected') : '');
            dingtalkHeaderBtn.attr('title', bound ? GourdI18n.t('streaming.dingtalk_bound') : GourdI18n.t('streaming.dingtalk_bind'));
        } catch(e) {}
    }, 'json');
}

// Page load: refresh status
updateDingTalkUI();

dingtalkHeaderBtn.on('click', function() {
    if (!activeSessionId) return;
    // If already bound, unbind
    if (dingtalkHeaderBtn.hasClass('bound')) {
        layConfirm(GourdI18n.t('streaming.dingtalk_unbind_confirm'), function() {
            $.post('/web/chat/dingtalk/unbind?sessionId=' + encodeURIComponent(activeSessionId)).always(function() {
                updateDingTalkUI();
            });
        });
        return;
    }
    // Not bound: show bind modal
    showDingTalkModal();
});

function showDingTalkModal() {
    if (dingtalkModalOverlay) return;

    dingtalkModalOverlay = $('<div>').addClass('im-bind-modal-overlay').html(
        '<div class="im-bind-modal">'
        + '<div class="im-bind-modal-title" style="color:#0089FF">' + GourdI18n.t('streaming.dingtalk_bind') + '</div>'
        + '<div class="im-bind-modal-subtitle">' + GourdI18n.t('streaming.dingtalk_bind_subtitle') + '</div>'
        + '<div class="im-bind-input-group">'
        + '  <label class="im-bind-input-label">' + GourdI18n.t('streaming.dingtalk_appkey') + '</label>'
        + '  <input class="im-bind-input" id="dingtalkAppKeyInput" placeholder="' + GourdI18n.t('streaming.dingtalk_appkey_placeholder') + '" />'
        + '</div>'
        + '<div class="im-bind-input-group">'
        + '  <label class="im-bind-input-label">' + GourdI18n.t('streaming.dingtalk_appsecret') + '</label>'
        + '  <input class="im-bind-input" id="dingtalkAppSecretInput" type="password" placeholder="' + GourdI18n.t('streaming.dingtalk_appsecret_placeholder') + '" />'
        + '</div>'
        + '<div class="im-bind-status" id="dingtalkBindStatus">&nbsp;</div>'
        + '<button class="im-bind-confirm-btn dingtalk" id="dingtalkBindConfirmBtn">' + GourdI18n.t('streaming.connect') + '</button>'
        + '<button class="im-bind-modal-close" id="dingtalkModalClose">' + GourdI18n.t('streaming.cancel') + '</button>'
        + '<div class="im-bind-hint">' + GourdI18n.t('streaming.dingtalk_bind_hint') + '</div>'
        + '</div>'
    );
    $('body').append(dingtalkModalOverlay);

    var $modalContent = dingtalkModalOverlay.find('.im-bind-modal');

    $('#dingtalkModalClose').on('click', closeDingTalkModal);
    dingtalkModalOverlay.on('click', function(e) {
        if ($(e.target).is(dingtalkModalOverlay)) closeDingTalkModal();
    });

    var $appKeyInput = $('#dingtalkAppKeyInput');
    var $appSecretInput = $('#dingtalkAppSecretInput');
    var $statusEl = $('#dingtalkBindStatus');
    var $confirmBtn = $('#dingtalkBindConfirmBtn');

    $appKeyInput.focus();

    $confirmBtn.on('click', function() {
        var appKey = $appKeyInput.val().trim();
        var appSecret = $appSecretInput.val().trim();
        if (!appKey) {
            $statusEl.text(GourdI18n.t('streaming.dingtalk_enter_appkey')).addClass('error');
            return;
        }
        if (!appSecret) {
            $statusEl.text(GourdI18n.t('streaming.dingtalk_enter_appsecret')).addClass('error');
            return;
        }
        $statusEl.text(GourdI18n.t('streaming.dingtalk_starting_connection')).removeClass('error scanned');
        $confirmBtn.prop('disabled', true);
        $appKeyInput.prop('disabled', true);
        $appSecretInput.prop('disabled', true);

        var params = 'sessionId=' + encodeURIComponent(activeSessionId)
            + '&appKey=' + encodeURIComponent(appKey)
            + '&appSecret=' + encodeURIComponent(appSecret);

        $.ajax({
            url: '/web/chat/dingtalk/bind?' + params,
            method: 'POST',
            dataType: 'json'
        }).done(function(resp) {
            if (resp.code === 200) {
                // Stream 启动成功，进入等待钉钉消息状态
                $statusEl.text(GourdI18n.t('streaming.dingtalk_connection_success')).removeClass('error');
                $confirmBtn.hide();
                // 开始轮询绑定状态
                startDingTalkPoll();
            } else {
                $statusEl.text(resp.message || GourdI18n.t('streaming.connection_failed')).addClass('error');
                $confirmBtn.prop('disabled', false);
                $appKeyInput.prop('disabled', false);
                $appSecretInput.prop('disabled', false);
            }
        }).fail(function(jqXhr) {
            if (jqXhr.status) {
                $statusEl.text(GourdI18n.t('streaming.request_failed') + ' (' + jqXhr.status + ')').addClass('error');
            } else {
                $statusEl.text(GourdI18n.t('streaming.connection_failed')).addClass('error');
            }
            $confirmBtn.prop('disabled', false);
            $appKeyInput.prop('disabled', false);
            $appSecretInput.prop('disabled', false);
        });
    });

    function startDingTalkPoll() {
        if (dingtalkPollTimer) clearInterval(dingtalkPollTimer);
        var dotCount = 0;
        dingtalkPollTimer = setInterval(function() {
            dotCount = (dotCount + 1) % 4;
            var dots = '.'.repeat(dotCount);
            $statusEl.text(GourdI18n.t('streaming.waiting_for_dingtalk_message') + dots);

            $.get('/web/chat/dingtalk/status?sessionId=' + encodeURIComponent(activeSessionId), function(resp) {
                try {
                    var data = resp.data || {};
                    if (data.bound) {
                        // 绑定成功！
                        clearInterval(dingtalkPollTimer);
                        dingtalkPollTimer = null;
                        $statusEl.text(GourdI18n.t('streaming.bind_success')).removeClass('error').addClass('scanned');
                        setTimeout(function() {
                            closeDingTalkModal();
                            updateDingTalkUI();
                            switchToChatMode();
                        }, 1000);
                    }
                } catch(e) {}
            }, 'json');
        }, 2000);
    }

    // Enter key to confirm
    $appKeyInput.add($appSecretInput).on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            $confirmBtn.click();
        }
    });
}

function closeDingTalkModal() {
    if (dingtalkPollTimer) {
        clearInterval(dingtalkPollTimer);
        dingtalkPollTimer = null;
    }
    if (dingtalkModalOverlay) {
        dingtalkModalOverlay.remove();
        dingtalkModalOverlay = null;
    }
}

/* ===== 初始化：注册回调 + 激活默认会话 ===== */
onFinishStream = finishStream;
setActiveSession(SESSION_ID);
