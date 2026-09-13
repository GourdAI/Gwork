/* ===== app-streaming.js ===== */
/* 通信与核心流程：发送 + WebChunk + WebSocket */
/* 依赖：app-base.js, app-ui.js, app-history.js, app-message.js */

/* ===== Send from both inputs ===== */
$(welcomeSendBtn).on('click', function() { sendMessage(); });
$(chatSendBtn).on('click', function() {
    if (isStreaming && activeSessionId && sessionMap[activeSessionId]) {
        requestInterrupt(sessionMap[activeSessionId], false);
    } else {
        sendMessage();
    }
});

/* ===== 中断（停止）请求 =====
   后端语义：
   - cancelled：已取消，并会推送匹配 run 的 steer_cancelled + done（前端等 done 收敛）；
   - not_running：当前无运行中 run；
   - turn_changed：前端携带的 runId 已过期（例如 activeRunId 被历史回放覆写成陈旧值）。
   旧实现只挂了 .fail()（仅弹 toast），对 not_running / turn_changed 零处理、也无本地兜底。
   一旦命中 turn_changed，后端不会 dispose、不会下发 done，前端就永久停在流式态：
   计时器不停狂奔、停止按钮反复点也没用——这正是“点暂停却暂停不了、一直思考”的根因之一。
   现在：非 cancelled 一律回服务端真值（replay.running）对账，据此收尾；turn_changed 时先用 replay
   回传的权威 runId 校准本地 activeRunId，再重试一次中断（否则重试仍带陈旧 runId，形同虚设）。 */
function requestInterrupt(sess, isRetry) {
    if (!sess || !sess.sessionId) return;
    $.post('/web/chat/interrupt', {
        sessionId: sess.sessionId,
        runId: sess.activeRunId || ''
    }).done(function(resp) {
        var status = resp && resp.data && resp.data.status;
        if (status === 'cancelled') return; // 等 steer_cancelled + done 收敛
        reconcileSessionRunning(sess, { retryInterrupt: (status === 'turn_changed') && !isRetry, force: true });
    }).fail(function(xhr) {
        // Result.failure 也会走 fail 分支，语义在 responseJSON.data.status 里
        var status = xhr && xhr.responseJSON && xhr.responseJSON.data && xhr.responseJSON.data.status;
        if (status === 'not_running' || status === 'turn_changed') {
            reconcileSessionRunning(sess, { retryInterrupt: (status === 'turn_changed') && !isRetry, force: true });
            return;
        }
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_failed'), 'error');
        // 网络层失败：请求可能已到达后端，仍以服务端真值对账，避免永久卡在思考态
        reconcileSessionRunning(sess, { force: true });
    });
}

/* ===== 以服务端真值对账本地流式态 =====
   /web/chat/replay 的 running 字段来自后端 isSessionBusy（disposable 存活判定），是“本轮是否还在跑”
   的唯一权威真值。任何“done 丢失”（runId 不匹配、连接抖动、取消竞态、死锁后的乱序）都由这里兜底收敛，
   保证前端绝不会永久停在「思考中 + 计时器狂奔 + 停止按钮失灵」。 */
function reconcileSessionRunning(sess, opts) {
    opts = opts || {};
    if (!sess || !sess.sessionId || !sess.isStreaming) return;
    var gen = sess._reconcileGen = (sess._reconcileGen || 0) + 1;
    var rootQ = sess.projectRoot ? '&root=' + encodeURIComponent(sess.projectRoot) : '';
    $.get('/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId) + rootQ
            + '&afterSeq=' + encodeURIComponent(sess.lastEventSeq || 0) + '&limit=1')
        .done(function(resp) {
            if (sess._reconcileGen !== gen || !sess.isStreaming) return;
            var data = (resp && resp.data) || {};
            // 用服务端权威 currentRunId 校准本地 activeRunId。本地值可能被历史回放写成陈旧值，
            // 若不校准就直接重试中断，只会再吃一个 turn_changed（重试形同虚设）。
            if (data.runId) sess.activeRunId = data.runId;
            if (data.running) {
                if (opts.retryInterrupt) requestInterrupt(sess, true);
                return;
            }
            // 服务端已空闲：仅在“确已停摆”（用户主动停止，或长时间无任何事件）时才强制收尾，
            // 避免把启动窗口内（running 尚未变 true）的新 run 误砍。
            // 停摆判定取「最近事件时间」与「本轮流起点」的较新者：lastEventAt 可能是上一轮遗留的旧值，
            // 若短路取到它，会把「新 run 刚发起、服务端 running 尚为 false」的启动窗口误判为停摆。
            var lastActivity = Math.max(sess.lastEventAt || 0, sess._streamStartAt || 0);
            var stalled = (Date.now() - lastActivity) >= STREAM_STALL_MS;
            if (!opts.force && !stalled) return;
            console.warn('[WebGate] reconcile: server idle, force finishStream for', sess.sessionId);
            sess.activeRunId = null;
            sess._pendingClientMessageId = null;
            sess._awaitingSendAck = false;
            // 与正常 done 路径对齐：强制收尾也必须放行消息队列派发，
            // 否则早前因流式态被抑制的排队消息会永远不再触发。
            sess._suppressQueueDispatch = false;
            finishStream(sess);
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.force_finished'), 'warning');
        })
        .fail(function() { /* 对账失败：交给看门狗下一轮或后端 done */ });
}

/* ===== 流式态看门狗 =====
   全仓此前没有任何兜底收敛：一旦 done 因任何原因丢失，前端将永久停在流式态。
   看门狗周期性对账活跃流式会话：本地长时间无任何事件且服务端判定空闲 → 强制收尾。 */
var STREAM_STALL_MS = 20000;
var STREAM_WATCHDOG_INTERVAL = 15000;
function startStreamWatchdog() {
    if (window._streamWatchdogTimer) return;
    window._streamWatchdogTimer = setInterval(function() {
        for (var sid in sessionMap) {
            if (!sessionMap.hasOwnProperty(sid)) continue;
            var sess = sessionMap[sid];
            if (!sess || !sess.isStreaming || sess._replaying) continue;
            // 同对账：取较新值，避免上一轮遗留的 lastEventAt 造成误判
            if (Date.now() - Math.max(sess.lastEventAt || 0, sess._streamStartAt || 0) < STREAM_STALL_MS) continue;
            reconcileSessionRunning(sess, {});
        }
    }, STREAM_WATCHDOG_INTERVAL);
}
window.startStreamWatchdog = startStreamWatchdog;

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
function queueRunningText(sess, text) {
    var queueText = (text || '').trim();
    if (!queueText || !window.messageQueue) return;
    window.messageQueue.add(sess.sessionId, queueText, [], []).then(function() {
        updateMessageQueueUI();
        clearInput();
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.queued'), 'info');
    });
}

function makeSteerId() {
    return 'steer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function sendSteer(sess, text) {
    if (!sess || sess._steerSending) return;
    var steerId = makeSteerId();
    var snapshot = (text || '').trim();
    var runId = sess.activeRunId || '';
    var pending = { steerId: steerId, text: snapshot, runId: runId, createdAt: Date.now(), state: 'sending' };
    sess.steerPending[steerId] = pending; // 先登记，处理 WS applied 早于 HTTP 200 的竞态
    sess._steerSending = true;

    $.ajax({
        url: '/web/chat/steer',
        method: 'POST',
        data: { sessionId: sess.sessionId, runId: runId, steerId: steerId, text: snapshot },
        headers: sess.projectRoot ? { 'X-Session-Cwd': sess.projectRoot } : {}
    }).done(function(resp) {
        var status = resp && resp.data && resp.data.status;
        if ((resp && resp.code === 200) && (status === 'accepted' || status === 'duplicate')) {
            if (!sess.steerResolved[steerId] && sess.steerPending[steerId]) {
                sess.steerPending[steerId].state = 'accepted';
            }
            clearInput();
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_accepted'), 'info');
            return;
        }
        delete sess.steerPending[steerId];
        // run 已切换/刚结束或邮箱已满：可靠降级为已有持久化队列。
        queueRunningText(sess, snapshot);
        if (typeof showToast === 'function') {
            var key = status === 'box_full' ? 'streaming.steer_box_full' : 'streaming.steer_deferred';
            showToast(GourdI18n.t(key), 'info');
        }
    }).fail(function() {
        delete sess.steerPending[steerId];
        // 网络失败不清空输入，不自动重试，避免是否已受理不确定时重复执行。
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_failed'), 'error');
    }).always(function() {
        sess._steerSending = false;
    });
}

function sendMessage(forceQueue) {
    var inputEl = inChatMode ? chatInput : welcomeInput;
    var rawText = inputEl ? inputEl.value : '';
    var text = getInputText();
    if (!text && pendingFiles.length === 0) return;
    /* Block only if the active session is currently streaming */
    // 任务执行中或队列有未处理消息，将消息加入队列
    var isBlocked = activeSessionId && sessionMap[activeSessionId] && sessionMap[activeSessionId].isStreaming;
    
    if (isBlocked) {
        var blockedSess = sessionMap[activeSessionId];
        // 当前队列只持久化附件名，不持久化 File；禁止伪排队后静默丢附件。
        if (pendingFiles.length > 0) {
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_attachment_wait'), 'info');
            return; // 保留文本与附件
        }
        if (forceQueue === true) {
            queueRunningText(blockedSess, text);
            return;
        }
        // 运行中 Enter：纯文本非命令即时插话；斜杠命令需 Tab 显式排队。
        if (text && text.trim().charAt(0) === '/') {
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_command_queue'), 'info');
            return;
        }
        sendSteer(blockedSess, text);
        return;
    }

    // 空闲发送前折叠超长输入：原文只保存在 TXT，避免超大气泡/Markdown/Prompt。
    var folded = (typeof foldLongInputToAttachment === 'function')
        ? foldLongInputToAttachment(rawText) : false;
    if (folded === null) return;
    if (folded === true) {
        text = GourdI18n.t('streaming.long_input_prompt');
        if (inputEl) {
            inputEl.value = '';
            inputEl._manualH = 0;
            autoResize(inputEl);
        }
    }

    if (pendingFiles.length > MAX_ATTACHMENTS) {
        showToast(GourdI18n.t('ui.attachment_limit', MAX_ATTACHMENTS), 'error');
        return;
    }
    var filesToSend = [];
    for (var fs = 0; fs < pendingFiles.length; fs++) {
        // 独立快照保留 File/dataUrl 引用；clearAttachmentPreview 只释放 pendingFiles 中的原对象，
        // HTTP 稍后返回 busy 时仍可安全补发附件。
        filesToSend.push($.extend({}, pendingFiles[fs]));
    }

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
    sess._pendingClientMessageId = 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    sess._requestStartSeq = sess.lastEventSeq || 0;
    sess._awaitingSendAck = true;
    sess._sendAckConfirmed = false;

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
    if (sess._pendingClientMessageId) formData.append('clientMessageId', sess._pendingClientMessageId);
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
        headers: sess.projectRoot
            ? { 'X-Session-Cwd': sess.projectRoot } : {}
    }).done(function(resp) {
        // 正常响应为 {"code":200}；若服务端判定会话繁忙（上一条任务未结束的重复触发），
        // 返回 data="busy"：前端暂存本条消息，待当前任务的 done 到达后自动补发，
        // 避免并行两个 ReAct 循环的 chunk 交错导致思考/正文错位
        var st = resp;
        if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
        if (st && st.data === 'busy') {
            sess._awaitingSendAck = false;
            sess._queueOriginItem = null;
            handleSendBusy(sess, text, filesToSend);
        } else if (st && st.code === 200) {
            sess._sendAckConfirmed = true;
            sess._awaitingSendAck = false;
            sess._queueOriginItem = null;
        }
    }).fail(function(err) {
        console.error('Send error:', err);
        var errMsg = GourdI18n.t('streaming.send_failed');
        if (typeof showToast === 'function') showToast(errMsg, 'error');
        // 请求可能已被服务端接受，只是响应在网络抖动中丢失。保留当前消息并进入 replay 确认，
        // 不能直接 finishStream，否则后端继续生成时同一回复会再次被拆开。
        sess._recovering = true;
        sess._recoverGeneration = (sess._recoverGeneration || 0) + 1;
        beginGateBuffer(sess);
        if (webGateSocket && webGateSocket.readyState === WebSocket.OPEN) recoverStreamingSession(sess);
        else ensureWebGateConnected();
    });
}

/* ===== 服务端繁忙（busy）处理 =====
   服务端对“会话已有任务在执行”的重复触发会跳过并返回 busy。
   前端此处收尾本地流状态，并暂存本条消息（非斜杠命令），
   待当前任务的 done 块到达后自动补发（不重复渲染用户气泡），确保消息不丢失。 */
function handleSendBusy(sess, text, filesToSend) {
    console.warn('[WebGate] server busy, message deferred for session:', sess.sessionId);
    var t = (text && text.trim()) ? text.trim() : '';
    var files = filesToSend ? filesToSend.slice() : [];
    // 保留完整发送快照。只存文本会使附件在 busy 竞态下静默丢失；纯附件消息也必须可补发。
    if ((t && t.charAt(0) !== '/') || files.length > 0) {
        sess._pendingResend = {
            text: t,
            files: files,
            clientMessageId: sess._pendingClientMessageId,
            projectRoot: sess.projectRoot || ''
        };
    }
    if (typeof showToast === 'function') {
        showToast(GourdI18n.t('streaming.busy_deferred'), 'warning');
    }
    finishStream(sess);
}

/* ===== 相位（生命周期）状态机 =====
   后端已在每个 WebChunk 上标注 phase（见 WebChunk.PHASE_*），表达「本帧之后引擎正处于什么相位」。
   旧实现只靠「任何帧之后静默 1 秒就弹思考点」猜测状态，完全不判断上一帧属于哪个相位，
   因此在正文流式、工具执行、等待审批、重试退避等场景一律误报为「思考中」。
   现改为相位驱动：静默时展示的是「上一帧所属相位」的真实文案与计时。 */
var PHASE_WAITING = 'waiting';
var PHASE_THINKING = 'thinking';
var PHASE_TEXT = 'text';
var PHASE_TOOL = 'tool';
var PHASE_HITL = 'hitl';
var PHASE_RETRY = 'retry';
var PHASE_DONE = 'done';

/* 相位 → 文案 i18n key。只给「主气泡底部指示器真正会出现」的相位配文案；
   tool/hitl/retry/done 各自已有专属指示器（工具卡绿点 / 授权卡 / 重试提示 / 结束态），不在此列。 */
var PHASE_I18N_KEY = {};
PHASE_I18N_KEY[PHASE_THINKING] = 'chat.phase_thinking';
PHASE_I18N_KEY[PHASE_TEXT] = 'chat.phase_text';
PHASE_I18N_KEY[PHASE_WAITING] = 'chat.phase_waiting';

/* 旧历史帧没有 phase 字段（反序列化为 undefined），降级为按 type 推断，保证回放不失效。
   返回 null 表示「本帧不改变相位」（元数据类帧与子代理活动帧）。 */
function inferPhaseFromType(type) {
    switch (type) {
        case 'reason': return PHASE_THINKING;
        case 'text': return PHASE_TEXT;
        case 'action_start': return PHASE_TOOL;
        // 骨架帧：模型已确定函数名 / 参数正在生成，语义就是「已进入工具相位」。
        // 归入 PHASE_TOOL 后底部指示器自动让位（showPhaseIndicator 对 PHASE_TOOL 短路）——
        // 此时骨架卡已出现并承担了进度语义，再叠一个「输出中」是误报。
        case 'action_draft': case 'action_args': return PHASE_TOOL;
        case 'action_end': return PHASE_WAITING;
        case 'hitl': return PHASE_HITL;
        case 'retry': return PHASE_RETRY;
        case 'trace': case 'done': case 'error': return PHASE_DONE;
        default: return null;
    }
}

/* 静默到期时按相位决定是否、以及如何展示等待指示器 */
function showPhaseIndicator(sess) {
    var phase = sess.phase || PHASE_WAITING;
    // tool：工具卡自己的绿色状态点就是指示器；hitl：授权卡带按钮；retry：重试提示自带旋转圈；
    // done：本轮已结束。这四种相位下再在主气泡底部叠一个点，会出现同屏两个闪烁指示器且语义冲突。
    if (phase === PHASE_TOOL || phase === PHASE_HITL || phase === PHASE_RETRY || phase === PHASE_DONE) return;
    // 思考块自身正在闪烁时，等待语义已由思考块头部承担，不重复显示
    if (sess.thinkingBlockEl) return;
    showInlineThinking(sess, phase);
}

/* ===== WebChunk Handling (Session-Aware) ===== */
function onWebChunk(sess, chunk) {
    try {
        /* file_changes 是 run 级被动快照：只更新独立持久卡，不得清等待指示器、推进
           currentRunId / activeRunId / phase，也不得重置静默计时。历史回放仍复用此入口。 */
        if (chunk.type === 'file_changes') {
            if (typeof window.onFileChangesChunk === 'function') window.onFileChangesChunk(sess, chunk);
            return;
        }

        // 事件活跃时间戮：看门狗/对账用它判断“是否长时间无任何事件”
        sess.lastEventAt = Date.now();

        if (sess.silenceTimer) {
            clearTimeout(sess.silenceTimer);
        }

        removeInlineThinking(sess);

        // 相位推进：优先用后端标注的真实相位，缺失时按 type 降级推断（旧历史帧）。
        // 元数据类帧（context_size / file_changes / agent_start / agent_end 等）不改变相位。
        var nextPhase = chunk.phase || inferPhaseFromType(chunk.type);
        if (nextPhase) sess.phase = nextPhase;

        // 存储当前 chunk 的 runId，用于后续消息渲染；主 run 单独追踪，防子代理 runId 覆盖插话目标。
        if (chunk.runId) {
            sess.currentRunId = chunk.runId;
            if (!(chunk.args && chunk.args.agentName)
                    && chunk.type !== 'agent_start' && chunk.type !== 'agent_end') {
                sess.activeRunId = chunk.runId;
            }
        }

        switch (chunk.type) {
            case 'command': finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendCommandOutput(sess, chunk.text); break;
            case 'rewind': finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); handleRewind(sess, parseInt(chunk.text) || 1); break;
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
                appendActionEndChunk(sess, chunk.toolName, chunk.text, chunk.args, chunk.toolTitle, chunk.actionId, chunk.truncated ? { truncated: true, seq: chunk.seq, fullLength: chunk.fullLength } : null, endOwnerState ? endOwnerState.bodyEl : null, { batchId: chunk.batchId, batchIndex: chunk.batchIndex, batchSize: chunk.batchSize }, chunk.failed === true, chunk.durationMs);
                if (window._todoChunkHandlers) window._todoChunkHandlers.forEach(function(h){h(chunk);});
                break;
            case 'action_draft': finishThinkingBlock(sess); clearRetryChunk(sess);
                // 与 action_start 完全对齐的归属路由：子代理的骨架卡必须落在它自己的卡片内，
                // 否则参数生成期卡片先出现在主对话、转正时又跳回卡内，会出现可见的位置跳变。
                var draftOwnerState = resolveAgentState(sess, chunk.args);
                if (draftOwnerState) { finishAgentThinkingBlock(sess, draftOwnerState); }
                appendActionDraftChunk(sess, chunk.toolName, chunk.toolTitle, chunk.actionId, chunk.args);
                break;
            case 'action_args':
                // 纯进度帧：不再重复做思考块/重试提示的收敛（action_draft 已做过），
                // 只更新骨架卡头部的参数体积，把长参数期的 DOM 开销压到最低。
                updateToolCardArgsProgress(sess, chunk.actionId, chunk.argsBytes);
                break;
            case 'action_start': finishThinkingBlock(sess); clearRetryChunk(sess);
                var startOwnerState = resolveAgentState(sess, chunk.args);
                if (startOwnerState) { finishAgentThinkingBlock(sess, startOwnerState); }
                appendActionStartChunk(sess, chunk.toolName, chunk.args, chunk.toolTitle, chunk.actionId, startOwnerState ? startOwnerState.bodyEl : null, { batchId: chunk.batchId, batchIndex: chunk.batchIndex, batchSize: chunk.batchSize });
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
                // 后端不会转发子代理的 RetryEvent（TaskTalent 只转发 ContextUsage/ToolCallStart/ToolCallEnd/ReasonDelta/ReasonEnd），
                // 故 retry 恒为主代理事件；且 WebChunk.ofRetry 不携带 agentName，无法归属，
                // 始终在主对话展示重试提示（下一 chunk 到达时自动清除），不得写入智能体卡片体
                appendRetryChunk(sess, chunk.text);
                break;
        case 'hitl':   finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendHitlCard(sess, chunk.toolName, chunk.command, chunk.actionId); break;
            case 'trace':  finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendTraceBadge(sess, chunk); break;
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
            if (!sess.isStreaming) return;
            // 存在活跃子智能体卡片时：运行中状态由卡片头部状态标识闪烁表示，
            // 不在主气泡底部显示全局指示器——多智能体并行时全局指示器归属不明（跑到卡片外）
            if (sess.agentStates && Object.keys(sess.agentStates).length > 0) return;
            // 相位感知：不再「无论上一帧是什么相位都弹思考点」，而是按真实相位决定显示什么
            showPhaseIndicator(sess);
        }, 1000);
        // 回放态：纯历史重建，不应触发「思考中」等待指示器（它依赖真实的流间隙）
        if (sess._replaying && sess.silenceTimer) { clearTimeout(sess.silenceTimer); sess.silenceTimer = null; }
    } catch (e) {}
}

function finishStream(sess) {
    var wasStreaming = sess.isStreaming;
    sess.isStreaming = false;
    sess.phase = PHASE_DONE;
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

    // 孤儿骨架卡（只收到 action_draft、从未收到 action_start）直接移除，而不是标黄点。
    // 用户点停止或模型吐参数途中出错时，留一张「只有工具名、无参数、无结果」的黄点空卡，
    // 比什么都不显示更让人误解为「工具执行失败」。必须在下方 loading→warn 扫尾之前执行。
    if (typeof removeOrphanArgsStreamingCards === 'function') removeOrphanArgsStreamingCards(sess);

    // 普通工具卡可在流结束时视为完成；批量卡需留给下方批次完整性检查，缺帧时标黄。
    if (sess.container) {
        $(sess.container).find('.tool-card:not([data-batch-key]) .tool-status-icon.loading').each(function() {
            this.className = 'tool-status-icon warn';
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

    // 收尾批量分组状态：完整批次标记成功；缺 start/end 或无效槽位的批次标记 warning，
    // 避免流已结束仍保留闪烁 loading，也避免把缺帧批次误报为全部成功。
    if (sess.toolBatchesById) {
        Object.keys(sess.toolBatchesById).forEach(function(key) {
            var b = sess.toolBatchesById[key];
            if (!b || !b.groupEl) return;
            var present = b.slots ? b.slots.filter(Boolean).length : 0;
            var complete = (b.doneCount || 0) >= (b.batchSize || 0) && present >= (b.batchSize || 0);
            var bIcon = $(b.groupEl).find('.tool-batch-header .tool-status-icon.loading')[0];
            if (bIcon) { bIcon.className = 'tool-status-icon ' + (complete ? 'done' : 'warn'); bIcon.innerHTML = ''; }
            $(b.groupEl).find('.tool-card .tool-status-icon.loading').each(function() {
                this.className = 'tool-status-icon warn'; this.innerHTML = '';
            });
            if (!complete) {
                $(b.groupEl).find('.tool-card .tool-status-icon.done').each(function() {
                    this.className = 'tool-status-icon warn';
                });
            }
        });
    }
    sess.toolBatchesById = {};
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

    // 使用本次结束会话自己的根刷新任务；后台会话收尾不能借用当前全局工作区。
    if (window.loadTodos && sess && sess.sessionId) {
        window.loadTodos(sess.sessionId, sess.projectRoot);
    }
    
    // 任务完成，自动处理当前会话的消息队列
    if (!sess._suppressQueueDispatch && sess && sess.sessionId && window.messageQueue) {
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
/* 报文指纹摘要：取代把整条 raw JSON 拼进指纹的做法。
   action_end 类帧携带工具输出（读文件/grep 结果）单帧可达数百 KB，滑窗内 200 条
   就是数十 MB 常驻（且同时被数组与对象两处引用）。用「长度 + 滚动哈希」代替全文：
   长度不同即不同帧；长度相同时靠哈希区分。叠加 type/sessionId/createdAt 三重限定后，
   碰撞仅发生在「同会话同类型同毫秒时间戳且长度相等」的帧之间，实际上就是重复推送本身。 */
function gateRawDigest(raw) {
    var s = String(raw == null ? '' : raw);
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;   // djb2, 保持 32 位整数
    }
    return s.length + ':' + (h >>> 0).toString(36);
}
var WEBGATE_MAX_RECONNECT = 10;
// 恢复期实时帧缓冲区容量上限（防止 replay 长期失败时无限堆积 chunk 对象）
var GATE_BUFFER_MAX = 3000;

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

// 连接断开时保留当前消息 DOM 和流式状态，重连后按 eventSeq 补回缺失事件。
function markStreamingSessionsForRecovery() {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var sess = sessionMap[sid];
        if (sess && sess.isStreaming) {
            sess._recovering = true;
            sess._recoverGeneration = (sess._recoverGeneration || 0) + 1;
            beginGateBuffer(sess);
        }
    }
}

function applySequencedGateChunk(sess, chunk) {
    if (!sess) return false;
    var seq = Number(chunk && chunk.eventSeq || 0);
    if (seq && seq <= (sess.lastEventSeq || 0)) return false;
    dispatchGateChunk(chunk);
    if (seq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, seq);
    return true;
}

function scheduleStreamingRecovery(sess, generation) {
    if (!sess || sess._recoverRetryTimer || !sess._recovering) return;
    var count = sess._recoverRetryCount || 0;
    var delay = Math.min(1000 * Math.pow(2, Math.min(count, 5)), 30000);
    sess._recoverRetryCount = count + 1;
    sess._recoverRetryTimer = setTimeout(function() {
        sess._recoverRetryTimer = null;
        if (sessionMap[sess.sessionId] === sess && sess._recovering
                && sess._recoverGeneration === generation
                && webGateSocket && webGateSocket.readyState === WebSocket.OPEN) {
            recoverStreamingSession(sess);
        }
    }, delay);
}

function recoverStreamingSession(sess) {
    if (!sess || sessionMap[sess.sessionId] !== sess || !sess._recovering || sess._resumePromise) return;
    var generation = sess._recoverGeneration;
    var rootQ = sess.projectRoot ? '&root=' + encodeURIComponent(sess.projectRoot) : '';
    var url = '/web/chat/replay?sessionId=' + encodeURIComponent(sess.sessionId)
        + rootQ + '&afterSeq=' + encodeURIComponent(sess.lastEventSeq || 0) + '&limit=500';
    var request = $.get(url);
    sess._resumePromise = request;
    request.done(function(resp) {
        if (!sess._recovering || sess._recoverGeneration !== generation) return;
        var data = resp && resp.data || {};
        var events = data.events || [];
        var ackMatched = !!sess._sendAckConfirmed;
        for (var i = 0; i < events.length; i++) {
            var recovered = events[i];
            if (recovered && recovered.type === 'user'
                    && recovered.clientMessageId && recovered.clientMessageId === sess._pendingClientMessageId) {
                ackMatched = true;
                sess._sendAckConfirmed = true;
                sess._awaitingSendAck = false;
                var userSeq = Number(recovered.eventSeq || 0);
                if (userSeq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, userSeq);
                continue;
            }
            applySequencedGateChunk(sess, recovered);
        }
        // 先把所有 replay 分页连续补齐，再处理 HTTP 快照期间缓冲的实时帧；否则实时高序号
        // 会提前推进游标，导致中间分页被 afterSeq 跳过。
        if (data.hasMore && sess._recovering) {
            if (sess._resumePromise === request) sess._resumePromise = null;
            recoverStreamingSession(sess);
            return;
        }
        var live = sess._gateBuffer || [];
        sess._gateBuffer = [];
        sess._gateBufferOverflowed = false;
        live.sort(function(a, b) { return Number(a.eventSeq || 0) - Number(b.eventSeq || 0); });
        for (var j = 0; j < live.length; j++) applySequencedGateChunk(sess, live[j]);
        sess._recovering = false;
        sess._gateBuffering = false;
        sess._recoverRetryCount = 0;
        if (sess._recoverRetryTimer) { clearTimeout(sess._recoverRetryTimer); sess._recoverRetryTimer = null; }
        // HTTP 失败既可能是“服务端已受理、响应丢失”，也可能是“请求根本未到达”。
        // replay 未发现本条 user 事件，且本次请求起点之后没有任何事件、服务端也未运行时，
        // 不能伪装成正常完成：明确标记失败并收尾，让用户可重新发送。
        if (sess._awaitingSendAck && !ackMatched && !data.running
                && (sess.lastEventSeq || 0) <= (sess._requestStartSeq || 0)) {
            sess._awaitingSendAck = false;
            appendErrorChunk(sess, GourdI18n.t('streaming.send_failed'));
            // 队列项已 shift 但请求确认未到服务端：重新入队，避免网络错误造成持久化消息永久丢失。
            if (sess._queueOriginItem && window.messageQueue) {
                var qi = sess._queueOriginItem;
                sess._queueOriginItem = null;
                window.messageQueue.add(sess.sessionId, qi.content || '', qi.imagePaths || [], qi.filePaths || []).always(function() {
                    finishStream(sess);
                });
                return;
            }
            finishStream(sess);
            return;
        }
        sess._awaitingSendAck = false;
        // 最终一页处理完后恢复真实 running 状态。中间 done 曾临时 finish UI，若服务端仍运行需继续保持流式；
        // 若已结束则此时才允许触发消息队列。
        if (data.running) {
            sess.isStreaming = true;
            if (sess.sessionId === activeSessionId) { isStreaming = true; setBtnStopMode(); }
        } else if (sess.isStreaming || sess._suppressQueueDispatch) {
            sess._suppressQueueDispatch = false;
            finishStream(sess);
        } else if (window.messageQueue) {
            processMessageQueue(sess.sessionId);
        }
    }).fail(function() {
        // replay 暂时失败时按会话指数退避，且删除会话后旧闭包会自行失效。
        scheduleStreamingRecovery(sess, generation);
    }).always(function() {
        // 只清理当前请求，不能把 done 回调中刚发起的下一页请求置空。
        if (sess._resumePromise === request) sess._resumePromise = null;
    });
}

function recoverStreamingSessions() {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        recoverStreamingSession(sessionMap[sid]);
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
        recoverStreamingSessions();
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
                var fp = (chunk.type || '') + '\u0001' + (chunk.sessionId || '') + '\u0001' + chunk.createdAt + '\u0001' + gateRawDigest(raw);
                if (gateFpSeen(fp)) return;
            }

            // 恢复/回放期间先缓冲；其它事件统一用 eventSeq 去重后分发。
            var gateSess = chunk.sessionId ? sessionMap[chunk.sessionId] : null;
            if (gateSess && (gateSess._replaying || gateSess._gateBuffering || gateSess._recovering)) {
                // 容量上限：若 replay 持续失败，会话会长期卡在恢复态，此处原本只进不出、无上限，
                // 是唯一能无限增长的 chunk 堆积点。超限后丢弃最早的帧：恢复完成时本就会走
                // loadMessages/replay 从服务端完整重建，缓冲区仅用于衔接窗口内的实时帧，
                // 丢旧留新不会造成最终内容缺失。
                if (gateSess._gateBuffer.length >= GATE_BUFFER_MAX) {
                    gateSess._gateBuffer.shift();
                    if (!gateSess._gateBufferOverflowed) {
                        gateSess._gateBufferOverflowed = true;
                        console.warn('[gate] _gateBuffer 超过 ' + GATE_BUFFER_MAX + ' 帧，开始丢弃最早帧（会话 ' + gateSess.sessionId + ' 恢复异常）');
                    }
                }
                gateSess._gateBuffer.push(chunk);
                return;
            }
            if (chunk && chunk.eventSeq && chunk.sessionId) {
                applySequencedGateChunk(gateSess || getOrCreateSession(chunk.sessionId), chunk);
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
        // 保留流式上下文，等待新连接通过 replay 精确补流。
        markStreamingSessionsForRecovery();
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
        var resumeInProgress = !!(sess._recovering || sess._gateBuffering);
        if (!resumeInProgress) {
            sess._recovering = false;
            sess._gateBuffering = false;
        }
        // 旧 run 的迟到 done 不得结束新 run；但绝不能静默丢弃：本地 activeRunId 可能被历史回放
        // 写成陈旧值（app-history.js 回放会经 onWebChunk 覆写 activeRunId，且 replayDone 不还原），
        // 此时新 run 的 done 会在此被吞掉，会话将永久停在流式态（计时器不停、停止按钮失灵）。
        // 故记录并按服务端真值对账收敛（服务端仍在跑时不动，避免误杀新 run）。
        if (!resumeInProgress && chunk.runId && sess.activeRunId && chunk.runId !== sess.activeRunId) {
            console.warn('[WebGate] stale-run done ignored (got ' + chunk.runId + ', active ' + sess.activeRunId + '); reconciling');
            sess._staleDoneSeen = true;
            setTimeout(function() { reconcileSessionRunning(sess, { force: true }); }, 0);
            return;
        }
        sess._pendingClientMessageId = null;
        sess._awaitingSendAck = false;
        sess._sendAckConfirmed = false;
        sess.activeRunId = null;
        sess._suppressQueueDispatch = resumeInProgress;
        finishStream(sess);
        sess._suppressQueueDispatch = false;
        if (resumeInProgress) {
            // replay 分页中的中间轮次 done 不能关闭整个恢复状态；后续页和实时缓冲仍要补齐。
            sess._recovering = true;
            sess._gateBuffering = true;
        }
        if (sess._pendingResend && !resumeInProgress) {
            var pending = sess._pendingResend;
            setTimeout(function retryPendingSend() {
                var s2 = sessionMap[sid];
                if (!s2 || s2._pendingResend !== pending) return;
                if (s2.isStreaming) {
                    setTimeout(retryPendingSend, 500);
                    return;
                }
                s2._pendingClientMessageId = pending.clientMessageId || s2._pendingClientMessageId;
                s2.projectRoot = pending.projectRoot || s2.projectRoot || '';
                s2._requestStartSeq = s2.lastEventSeq || 0;
                s2._awaitingSendAck = true;
                s2._sendAckConfirmed = false;
                sendWithFormDataGrouped(s2, pending.text || '', pending.files || []);
                // 只有真正发起补发后才移除；若 300ms 内另一任务启动，消息不会被静默丢弃。
                if (s2._pendingResend === pending) s2._pendingResend = null;
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

    /* file_changes 可能在 run 收尾后延迟到达，只是后端状态快照，不代表新流开始。
       必须在通用自动 streaming 分支之前消费，避免伪造 activeRunId、停止按钮和思考气泡。 */
    if (chunk.type === 'file_changes') {
        var fileChangesSess = getOrCreateSession(sid);
        if (typeof window.onFileChangesChunk === 'function') window.onFileChangesChunk(fileChangesSess, chunk);
        return;
    }

    // 插话协议事件必须在「自动进入 streaming 态」之前处理：历史回放 dropped/cancelled 不应制造假流。
    if (chunk.type === 'steer_applied' || chunk.type === 'steer_dropped' || chunk.type === 'steer_cancelled') {
        var steerSess = getOrCreateSession(sid);
        var items = (chunk.args && chunk.args.items) || [];
        for (var si = 0; si < items.length; si++) {
            var item = items[si] || {};
            if (!item.steerId || steerSess.steerResolved[item.steerId]) continue;
            steerSess.steerResolved[item.steerId] = chunk.type;
            delete steerSess.steerPending[item.steerId];
            if (chunk.type === 'steer_applied' && typeof appendSteerNote === 'function') {
                appendSteerNote(steerSess, item);
            }
        }
        if (chunk.type === 'steer_dropped') {
            // 后端已按 originSteerId 原子、幂等入 queue.json；前端只失效缓存并刷新 UI。
            if (window.messageQueue && window.messageQueue.caches) delete window.messageQueue.caches[sid];
            if (sid === activeSessionId && typeof updateMessageQueueUI === 'function') updateMessageQueueUI();
            if (!steerSess._replaying && typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_dropped'), 'info');
        }
        return;
    }

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
        console.warn('[WebGate] reconnect attempts continuing at capped interval');
        webGateReconnectAttempts = WEBGATE_MAX_RECONNECT - 1;
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

// 流式态看门狗常驻启动（依赖已加载的 sessionMap / reconcileSessionRunning）。
startStreamWatchdog();

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
        // 绑定本次切换的会话及其所属根，避免异步请求读取后续变化的全局工作区。
        var todoSess = (typeof sessionMap !== 'undefined' && sessionMap) ? sessionMap[sid] : null;
        if (window.loadTodos) window.loadTodos(sid, todoSess ? todoSess.projectRoot : '');
        // 切换会话时把「本轮文件变更」入口切到新会话的最新一轮（chip 显隐/面板内容由 app-file-changes.js 汇算）
        if (window.refreshFileChangesChip) window.refreshFileChangesChip(sid);
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
