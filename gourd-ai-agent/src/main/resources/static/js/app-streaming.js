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
            if (!sess) continue;
            /* 回放守卫必须先于一切介入：回放机制会临时编排 sess.isStreaming
             * （replaySession 入口置 false、逐事件 true/false 切换、replayDone 按快照恢复），
             * 期间「全局 true + 会话 false」是合法瞬态——典型如流式进行中触发加载更多的
             * prepend 回放；分片回放跨多个 rAF 帧，后台标签页 rAF 暂停时窗口可持续数分钟。
             * 在此窗口内做背离校正会把正在流式输出的会话按钮误复位成发送态。 */
            if (sess._replaying) continue;
            /* 状态背离校正（按钮未复位专项）：会话已结束（sess.isStreaming=false）但全局
             * 按钮仍停在停止态——finishStream 中段异常、渲染管线半路崩溃等历史残留。
             * 看门狗原本以 isStreaming 为门槛直接跳过这类会话，形成永久卡死。
             * 校正动作幂等且零 DOM 代价：只同步全局态到会话真值。 */
            if (!sess.isStreaming) {
                if (sess.sessionId === activeSessionId && isStreaming) {
                    console.warn('[WebGate] watchdog: button/state divergence corrected for', sid);
                    syncSendButtonToSessionState(sess);
                }
                continue;
            }
            // 同对账：取较新值，避免上一轮遗留的 lastEventAt 造成误判
            if (Date.now() - Math.max(sess.lastEventAt || 0, sess._streamStartAt || 0) < STREAM_STALL_MS) continue;
            reconcileSessionRunning(sess, {});
        }
    }, STREAM_WATCHDOG_INTERVAL);
}
window.startStreamWatchdog = startStreamWatchdog;

/* ===== Click to focus =====
   豁免 .workspace-selector：工作区下拉（搜索框/项目列表）渲染在 composer 托盘内，
   点击其中的 INPUT 搜索框若被抢回聊天输入框，搜索将永远打不进字（实测 FOCUSIN 序列证实）。 */
$('.welcome-input-box').on('click', function(e) {
    if (!$(e.target).closest('button').length && !$(e.target).closest('.loop-panel').length
        && !$(e.target).closest('.workspace-selector').length) welcomeInput.focus();
});
$('.input-box').on('click', function(e) {
    if (!$(e.target).closest('button').length && !$(e.target).closest('.history-panel').length && !$(e.target).closest('.loop-panel').length && !$(e.target).closest('.todo-float-panel').length
        && !$(e.target).closest('.workspace-selector').length) chatInput.focus();
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
/* 运行中入队。imagePaths / filePaths 是【已落盘】的会话内相对路径（uploads/xxx），
   纯文本入队时省略。文本与附件都为空时不入队——旧实现只判文本，纯附件消息会被静默丢弃。 */
function queueRunningText(sess, text, imagePaths, filePaths, toastKey) {
    var queueText = (text || '').trim();
    var images = imagePaths || [];
    var files = filePaths || [];
    if (!window.messageQueue) return;
    if (!queueText && images.length === 0 && files.length === 0) return;
    window.messageQueue.add(sess.sessionId, queueText, images, files).then(function() {
        updateMessageQueueUI();
        clearInput();
        clearAttachmentPreview();
        var key = toastKey
            || ((images.length || files.length) ? 'streaming.queued_with_attachments' : 'streaming.queued');
        if (typeof showToast === 'function') showToast(GourdI18n.t(key), 'info');
    }, function() {
        // 入队失败绝不清空：文本与附件都还留在输入框里，用户看得见、也能重试。
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.queue_failed'), 'error');
    });
}

/* ===== 附件预上传 =====
   插话（/web/chat/steer）是纯文本表单、队列（queue.json）存的是相对路径，两条通道都表达不了
   浏览器内存里的 File。所以运行中带附件时必须先落盘，再用路径走原有通道。
   落盘目录与正常发送完全一致（<sessionDir>/uploads/），延后发送读到的是同一份文件。
   resolve: { imagePaths, filePaths, items }；reject: 上传失败（调用方须保留输入与附件） */
function uploadPendingAttachments(sess, files) {
    var formData = new FormData();
    formData.append('sessionId', sess.sessionId);
    for (var i = 0; i < files.length; i++) {
        formData.append('attachments', files[i].file, files[i].name);
        formData.append('attachmentTypes', files[i].attachmentsType || 'file');
    }
    var headers = {};
    var cwd = sess.projectRoot || (typeof getSessionCwd === 'function' ? getSessionCwd() : '');
    if (cwd) headers['X-Session-Cwd'] = encodeSessionCwdHeader(cwd);

    return $.ajax({
        url: '/web/chat/attachment/upload',
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        headers: headers
    }).then(function(resp) {
        var st = resp;
        if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
        var items = (st && st.code === 200 && st.data && st.data.items) || [];
        if (!items.length) return $.Deferred().reject(new Error('upload_failed')).promise();
        // 图片/文件的归类以服务端为准：它按扩展名与声明类型共同判定，
        // 与发送主链路同一口径，避免同一张图在两条路径上被当成不同东西。
        var imagePaths = [], filePaths = [];
        for (var k = 0; k < items.length; k++) {
            if (items[k].type === 'image') imagePaths.push(items[k].path);
            else filePaths.push(items[k].path);
        }
        return { imagePaths: imagePaths, filePaths: filePaths, items: items };
    });
}

/* 上传输入框里的附件，成功后把引用交给 onUploaded。
   两条铁律：
   ① 任何一步失败都不清空输入框与附件预览——附件已落盘不算丢，但用户视角里
      「我按了发送却什么都没发生」比一条失败提示糟糕得多；
   ② 上传是异步的，回来时必须确认输入区没被用户改过，否则会把用户刚删掉的附件发出去。 */
function withUploadedAttachments(sess, text, onUploaded) {
    if (sess._attachmentUploading) {
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.attachment_uploading'), 'info');
        return;
    }
    if (pendingFiles.length > MAX_ATTACHMENTS) {
        showToast(GourdI18n.t('ui.attachment_limit', MAX_ATTACHMENTS), 'error');
        return;
    }

    // 独立快照：clearAttachmentPreview 只释放 pendingFiles 中的原对象，
    // 上传期间用户切走会话（草稿 stash）也不会让这些引用失效。
    var files = [];
    var names = [];
    for (var i = 0; i < pendingFiles.length; i++) {
        files.push($.extend({}, pendingFiles[i]));
        names.push(pendingFiles[i].name);
    }
    var version = _pendingFilesVersion;

    /* 输入区是否仍是按下发送键时的样子。附件名是全局唯一的（app-ui.js 生成唯一名防覆盖），
       按名字逐个比对即可发现「上传期间删了/加了附件」；文本与版本号一起兜住改写与清空。 */
    function inputUnchanged() {
        if (_pendingFilesVersion !== version) return false;
        if (getInputText() !== text) return false;
        if (pendingFiles.length !== names.length) return false;
        for (var n = 0; n < names.length; n++) {
            var found = false;
            for (var m = 0; m < pendingFiles.length; m++) {
                if (pendingFiles[m].name === names[n]) { found = true; break; }
            }
            if (!found) return false;
        }
        return true;
    }

    sess._attachmentUploading = true;
    uploadPendingAttachments(sess, files).then(function(refs) {
        if (!inputUnchanged()) {
            // 用户在上传期间动了输入区：放弃本次提交，保留现场让他重新确认后再发。
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.attachment_changed'), 'info');
            return;
        }
        onUploaded(refs);
    }, function() {
        if (!inputUnchanged()) return;
        if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.attachment_upload_failed'), 'error');
    }).always(function() {
        sess._attachmentUploading = false;
    });
}

/* 运行中带附件的提交：附件落盘后按 Enter/Tab 的语义分流到插话或队列。 */
function sendBlockedWithAttachments(sess, text, forceQueue) {
    withUploadedAttachments(sess, text, function(refs) {
        if (forceQueue === true) {
            queueRunningText(sess, text, refs.imagePaths, refs.filePaths);
            return;
        }
        sendSteer(sess, text, refs.imagePaths, refs.filePaths);
    });
}

/* 问答卡挂起时带附件：文本照常填进当前题的答案，附件单独排入队列（content 为空），
   等本轮作答恢复的任务结束后由队列链路带附件发送。
   顺序讲究：必须先落答案、再传附件。applyQuestionCustomAnswerByText 内部会 clearInput()，
   而 queueRunningText 入队成功后也会 clearInput()——若先入队再填答案，一旦答案落空
   （卡片已被别处收起），那段文字就被 clearInput 抹掉且无处可去；反过来先填答案，
   上传失败时答案已在卡片里、附件仍在输入框，两边都不丢，用户重按 Enter 即可续上。 */
function queueQuestionAttachments(sess, text) {
    var answer = (text || '').trim();
    if (answer) {
        if (typeof applyQuestionCustomAnswerByText !== 'function'
                || !applyQuestionCustomAnswerByText(sess, answer)) {
            // 答案无处安放：原地保留文本与附件，提示用户先回答或跳过这道题。
            if (typeof showToast === 'function') showToast(GourdI18n.t('chat.question_attachment_wait'), 'info');
            return;
        }
    }
    // 答案已落位（输入框随之被清空）：以清空后的输入区为基准做「未变」校验，
    // 否则守卫会拿旧文本比对而必然失配，把刚传好的附件白白丢掉。
    withUploadedAttachments(sess, getInputText(), function(refs) {
        queueRunningText(sess, '', refs.imagePaths, refs.filePaths,
            answer ? 'chat.question_attachment_queued' : 'streaming.queued_with_attachments');
    });
}

function makeSteerId() {
    return 'steer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function sendSteer(sess, text, imagePaths, filePaths) {
    if (!sess || sess._steerSending) return;
    var steerId = makeSteerId();
    var snapshot = (text || '').trim();
    var images = imagePaths || [];
    var files = filePaths || [];
    var hasAttachments = images.length > 0 || files.length > 0;
    var runId = sess.activeRunId || '';
    var pending = { steerId: steerId, text: snapshot, runId: runId, createdAt: Date.now(), state: 'sending',
        imagePaths: images, filePaths: files };
    sess.steerPending[steerId] = pending; // 先登记，处理 WS applied 早于 HTTP 200 的竞态
    sess._steerSending = true;

    $.ajax({
        url: '/web/chat/steer',
        method: 'POST',
        // traditional：数组序列化成 imagePaths=a&imagePaths=b，后端按重复表单键取全量
        traditional: true,
        data: { sessionId: sess.sessionId, runId: runId, steerId: steerId, text: snapshot,
            imagePaths: images, filePaths: files },
        headers: sess.projectRoot ? { 'X-Session-Cwd': encodeSessionCwdHeader(sess.projectRoot) } : {}
    }).done(function(resp) {
        var status = resp && resp.data && resp.data.status;
        if ((resp && resp.code === 200) && (status === 'accepted' || status === 'duplicate')) {
            if (!sess.steerResolved[steerId] && sess.steerPending[steerId]) {
                sess.steerPending[steerId].state = 'accepted';
            }
            clearInput();
            clearAttachmentPreview();
            if (typeof showToast === 'function') {
                showToast(GourdI18n.t(hasAttachments
                    ? 'streaming.steer_accepted_with_attachments' : 'streaming.steer_accepted'), 'info');
            }
            return;
        }
        delete sess.steerPending[steerId];
        // 服务端判定这条插话没有可执行内容（空文本 + 附件路径全被判非法）：
        // 不能谎报「已加入队列」，如实提示失败并保留输入与附件。
        if (!snapshot && images.length === 0 && files.length === 0) {
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_failed'), 'error');
            return;
        }
        // run 已切换/刚结束或邮箱已满：可靠降级为已有持久化队列，附件路径一并带过去，
        // 否则「插话 → 转队列」这一跳会把用户刚上传的图片静默丢掉。
        // 提示语走 toastKey 传进去：box_full / deferred 两句本身已含「已加入队列」，
        // 再叠一条 queued 就是重复提示。
        queueRunningText(sess, snapshot, images, files,
            status === 'box_full' ? 'streaming.steer_box_full' : 'streaming.steer_deferred');
    }).fail(function() {
        delete sess.steerPending[steerId];
        // 网络失败不清空输入与附件，不自动重试，避免是否已受理不确定时重复执行。
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

    /* 问答挂起路由：当前会话有待作答的结构化问答卡时，输入框文本等价于卡片内「其他补充」，
       直接记为当前题的自定义答案，不得进入普通发送链路（streaming/steer/queue 行为不受影响）。
       附件不能进答案（答案协议只有 text 字段）：先落盘再排入队列，等本轮作答恢复的任务结束后
       由队列链路带附件发送——既不阻塞作答，也不静默吞掉附件。 */
    if (activeSessionId && sessionMap[activeSessionId]
            && typeof getPendingQuestionState === 'function') {
        var pendingQuestion = getPendingQuestionState(sessionMap[activeSessionId]);
        if (pendingQuestion) {
            if (pendingFiles.length > 0) {
                queueQuestionAttachments(sessionMap[activeSessionId], text);
                return;
            }
            if (text && typeof applyQuestionCustomAnswerByText === 'function'
                    && applyQuestionCustomAnswerByText(sessionMap[activeSessionId], text)) {
                return;
            }
        }
    }

    /* Block only if the active session is currently streaming */
    // 任务执行中或队列有未处理消息，将消息加入队列
    var isBlocked = activeSessionId && sessionMap[activeSessionId] && sessionMap[activeSessionId].isStreaming;
    
    if (isBlocked) {
        var blockedSess = sessionMap[activeSessionId];
        var isCommand = text && text.trim().charAt(0) === '/';
        if (isCommand && pendingFiles.length > 0) {
            // 命令是纯文本协议：带附件排队会被后端当普通消息发给模型（附件让命令判定失效），
            // 把 "/rerun" 变成一句提示词。明确拦下，而不是让用户事后发现命令没执行。
            if (typeof showToast === 'function') {
                showToast(GourdI18n.t('streaming.command_attachment_unsupported'), 'info');
            }
            return; // 保留文本与附件
        }
        // 运行中 Enter：非命令即时插话；斜杠命令需 Tab 显式排队。
        if (isCommand && forceQueue !== true) {
            if (typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_command_queue'), 'info');
            return;
        }
        // 附件只存在于浏览器内存，插话与队列两条通道都只能表达会话内相对路径：
        // 先落盘再走原有通道，任何一步失败都保留输入与附件。
        if (pendingFiles.length > 0) {
            sendBlockedWithAttachments(blockedSess, text, forceQueue === true);
            return;
        }
        if (forceQueue === true) {
            queueRunningText(blockedSess, text);
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

    var fromWelcome = !inChatMode;
    if (fromWelcome) switchToChatMode();
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
    ensureSidebarRefreshTimer();
    setBtnStopMode();
    resetStreamState(sess);
    showThinking(sess);

    sendWithFormData(sess, text, filesToSend);

    // Clear input & attachment preview AFTER message is rendered and sent,
    // otherwise releaseAttachmentData() would null out dataUrl/file in the
    // shallow-copied filesToSend snapshot (filesToSend = pendingFiles.slice()),
    // causing broken image icons and empty file uploads.
    clearInput(fromWelcome);
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
    ensureSidebarRefreshTimer();
    setBtnStopMode();
    resetStreamState(sess);
    showThinking(sess);

    sendWithFormDataGrouped(sess, cmdText, []);
}
window.sendCommandSilent = sendCommandSilent;

/**
 * 统一的 /web/chat/input 提交入口。
 *
 * 三条调用路径（正常发送 / 问答卡作答 / HITL 决策）原先各自手写 FormData，
 * 字段清单靠人工记忆同步，已经造成过「续轮路径漏带 model」这类结构性隐患：
 * 漏带后后端只能回落到会话上下文或 defaultModel，而这一回落是无声的。
 * 此处把公共字段（sessionId / model / X-Session-Cwd）收敛到一处，
 * 路径独有字段由 fields 传入，响应与失败语义由 hooks 决定。
 *
 * @param sess   会话对象
 * @param fields 该路径独有的字段。【关键语义】只有显式出现的键才会被 append，
 *               绝不对缺失的键补空串——后端靠 input 键的【存在性】区分「新一轮」与
 *               「续轮」，给 HITL/问答卡凭空加一个空 input 会把续轮误判成新轮。
 * @param files  附件数组（仅正常发送路径传）。两种形态：{file, name, attachmentsType} 走 multipart
 *               上传；{path, attachmentsType} 引用会话内已落盘的附件——队列出队与 busy 补发
 *               手里只有相对路径，拿不到 File 对象
 * @param hooks  { onBusy, onDone, onFail }；三条路径失败后的收尾动作各不相同，不下沉
 */
function postChatInput(sess, fields, files, hooks) {
    var formData = new FormData();
    formData.append('sessionId', sess.sessionId);

    // 公共字段：当前选中模型。三条路径统一携带。
    // （后端在缺省时会从会话 context 的已选模型回读，两者等价；显式携带是为了
    //   消除「哪条路径带了、哪条没带」的记忆负担，以及 context 写入失败时的兑底。）
    var model = (typeof getSelectedModel === 'function') ? getSelectedModel() : '';
    if (model) formData.append('model', model);

    // 路径独有字段：按键存在性 append，不做任何默认值补齐
    if (fields) {
        for (var k in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
            var v = fields[k];
            if (v === undefined || v === null) continue;
            formData.append(k, v);
        }
    }

    // 访问控制档位（会话级）：三条发送路径（正常发送/续轮/续答）统一携带，
    // 否则档位不会随消息生效。取值按会话查（可能晚于 send 触发的会话切换不被错误带入）。
    if (window.GourdAccessMode && typeof window.GourdAccessMode.modeForSession === 'function') {
        formData.append('accessMode', window.GourdAccessMode.modeForSession(sess.sessionId));
    }

    if (files && files.length) {
        for (var i = 0; i < files.length; i++) {
            if (files[i].file) {
                // 浏览器内存中的 File：multipart 上传，后端落盘到 <sessionDir>/uploads/
                formData.append('attachments', files[i].file, files[i].name);
                formData.append('attachmentTypes', files[i].attachmentsType || 'file');
            } else if (files[i].path) {
                // 已落盘附件（队列出队 / busy 补发）：只传会话内相对路径，后端读回同一份文件
                formData.append('attachmentPaths', files[i].path);
                formData.append('attachmentPathTypes', files[i].attachmentsType || 'file');
            }
        }
    }

    // 工作空间根：优先会话自身记录的，其次当前视图，避免工作空间切换后错位
    var headers = {};
    var cwd = (sess && sess.projectRoot) ? sess.projectRoot
        : (typeof getSessionCwd === 'function' ? getSessionCwd() : '');
    if (cwd) headers['X-Session-Cwd'] = encodeSessionCwdHeader(cwd);

    hooks = hooks || {};
    // 统一用 $.ajax：fetch 的 .catch 不会因 4xx/5xx 触发，原来的两条 fetch 路径遇到
    // 服务端错误时会静默卡死（卡片停在已提交态、流不收尾）。
    return $.ajax({
        url: SSE_ENDPOINT,
        method: 'POST',
        data: formData,
        processData: false,
        contentType: false,
        headers: headers
    }).done(function(resp) {
        var st = resp;
        if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = null; } }
        if (st && st.data === 'busy' && hooks.onBusy) { hooks.onBusy(st); return; }
        if (hooks.onDone) hooks.onDone(st);
    }).fail(function(err) {
        if (hooks.onFail) hooks.onFail(err);
    });
}
window.postChatInput = postChatInput;

function sendWithFormDataGrouped(sess, text, filesToSend) {
    /* 用户主动发起会话：确保【该会话所属环境】的 WebSocket 就绪（可能仍在启动或
       退避已耗尽）。传会话归属而非当前视图：队补发/后台任务的会话可能属于另一个桶，
       拿当前视图推导会把连接建到错的上游（事件流回不到本会话）。 */
    if (typeof ensureWebGateConnected === 'function') ensureWebGateConnected(sessionGateScopeKey(sess));
    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }

    // input 无条件携带（空串也发）：busy 补发纯附件消息时就是空串，
    // 且后端靠该键存在性识别「新一轮」。
    var fields = { input: text };
    if (sess._pendingClientMessageId) fields.clientMessageId = sess._pendingClientMessageId;

    // 【乐观清除「任务运行参数」提示条（2026-10-17 review M1 修复）】正常发言轮是前台对话轮，
    // 后端轮首会清取证键；但前端内存缓存（loopRunBannerBySession）无失效时机，
    // 横幅会停在陈旧态继续声称「按任务参数运行」，且切走再切回命中缓存跳过拉取、永不自愈。
    // 命令（/xxx）不发起新一轮，不清；busy/fail 时本条未真正开轮，用 restore 回补后端权威态。
    var isPlainTurn = !(typeof text === 'string' && text.indexOf('/') === 0);
    if (isPlainTurn && typeof window.clearLoopRunBanner === 'function') {
        window.clearLoopRunBanner(sess.sessionId);
    }

    // 标记流式状态，WebSocket onmessage 会处理数据
    sess.isStreaming = true;
    ensureSidebarRefreshTimer();
    if (sess.sessionId === activeSessionId) {
        isStreaming = true;
        setBtnStopMode();
    }
    resetStreamState(sess);
    showThinking(sess);

    postChatInput(sess, fields, filesToSend, {
        // 服务端判定会话繁忙（上一条任务未结束的重复触发）：前端暂存本条消息，
        // 待当前任务的 done 到达后自动补发，避免并行两个 ReAct 循环的 chunk 交错
        onBusy: function() {
            sess._awaitingSendAck = false;
            sess._queueOriginItem = null;
            // busy = 本条未开新轮（上一任务仍在跑）：回补乐观清除，与后端权威态对齐
            if (isPlainTurn && typeof window.restoreLoopRunBanner === 'function') {
                window.restoreLoopRunBanner(sess.sessionId);
            }
            handleSendBusy(sess, text, filesToSend);
        },
        onDone: function(st) {
            if (st && st.code === 200) {
                sess._sendAckConfirmed = true;
                sess._awaitingSendAck = false;
                sess._queueOriginItem = null;
            }
        },
        onFail: function(err) {
            console.error('Send error:', err);
            // 请求可能未达服务端（未开轮）：回补乐观清除，以取证端点权威态为准
            if (isPlainTurn && typeof window.restoreLoopRunBanner === 'function') {
                window.restoreLoopRunBanner(sess.sessionId);
            }
            var errMsg = GourdI18n.t('streaming.send_failed');
            if (typeof showToast === 'function') showToast(errMsg, 'error');
            // 请求可能已被服务端接受，只是响应在网络抖动中丢失。保留当前消息并进入 replay 确认，
            // 不能直接 finishStream，否则后端继续生成时同一回复会再次被拆开。
            sess._recovering = true;
            sess._recoverGeneration = (sess._recoverGeneration || 0) + 1;
            beginGateBuffer(sess);
            /* 按【该会话所属环境】取连接（不再看全局单例）：发送失败的会话可能属于
               远端桶，而当前视图在本地——用全局当前桶判定会把「远端连接其实还活着」
               误判成死，白白走一次 replay。 */
            var failScope = sessionGateScopeKey(sess);
            if (gateSocketAlive(failScope)) recoverStreamingSession(sess);
            else ensureWebGateConnected(failScope);
        }
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
/* 结构化问答（ask_user）等待用户作答期间的真实相位。卡片自带交互与状态展示，不叠底部指示器。 */
var PHASE_QUESTION = 'question';
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
        // 思考已开始但内容尚未到达（甚至永远不来：Claude 等模型会屏蔽思维链明文，
        // 思考真实发生、计费与耗时照常，但思考文本全程为空）。该帧不携带内容、不建任何 DOM，
        // 唯一作用就是把相位从 waiting 推到 thinking —— 否则整段思考期零帧，底部指示器
        // 会一直显示「等待响应」并从头累加计时，可后端其实早已开始响应。
        case 'reason_start': return PHASE_THINKING;
        case 'text': return PHASE_TEXT;
        case 'action_start': return PHASE_TOOL;
        // 骨架帧：模型已确定函数名 / 参数正在生成，语义就是「已进入工具相位」。
        // 归入 PHASE_TOOL 后底部指示器自动让位（showPhaseIndicator 对 PHASE_TOOL 短路）——
        // 此时骨架卡已出现并承担了进度语义，再叠一个「输出中」是误报。
        case 'action_draft': case 'action_args': case 'action_batch': return PHASE_TOOL;
        case 'action_end': return PHASE_WAITING;
        case 'hitl': return PHASE_HITL;
        // 释放帧不推进相位：它只收卡，不改变「本轮在等什么」的语义（后端清挂起后
        // 引擎流随即正常结束并补 done，相位由 done 收口）。
        case 'hitl_released': return null;
        case 'question': return PHASE_QUESTION;
        // 问答已闭环（本人提交或他端作答）：引擎在消费答案后继续执行，语义等同「引擎处理中」，
        // 归入 PHASE_WAITING；若沿用 PHASE_QUESTION 会让底部指示器在卡片隐藏后长期缺席。
        case 'question_answered': return PHASE_WAITING;
        case 'retry': return PHASE_RETRY;
        case 'trace': case 'done': case 'error': return PHASE_DONE;
        default: return null;
    }
}

/* 静默到期时按相位决定是否、以及如何展示等待指示器 */
function showPhaseIndicator(sess) {
    var phase = sess.phase || PHASE_WAITING;
    // tool：工具卡自己的绿色状态点就是指示器；hitl：授权卡带按钮；question：问答卡自带交互；
    // retry：重试提示自带旋转圈；done：本轮已结束。这些相位下再在主气泡底部叠一个点，
    // 会出现同屏两个闪烁指示器且语义冲突。
    if (phase === PHASE_TOOL || phase === PHASE_HITL || phase === PHASE_QUESTION || phase === PHASE_RETRY || phase === PHASE_DONE) return;
    // 思考块自身正在闪烁时，等待语义已由思考块头部承担，不重复显示
    if (sess.thinkingBlockEl) return;
    showInlineThinking(sess, phase);
}

/* ===== WebChunk Handling (Session-Aware) ===== */
/* 帧入口双保险过滤（契约 §3.3）：只在 gateRxScopeKey 非空（= 帧来自 WS onmessage）
   时生效。HTTP 回放路径（app-history.js 的 loadMessages/replay）直接调本函数，
   此时 gateRxScopeKey 为 null → 不参与过滤，回放主链语义零改动（契约 §3.6）。 */
function gateFrameScopeMismatch(chunk) {
    if (!gateRxScopeKey) return false;
    var k = gateChunkScopeKey(chunk);
    // null = 归属未知（会话未建/全局会话无登记表）：一律放行，误杀帧 = 内容永久缺失
    return (k !== null && k !== gateRxScopeKey);
}

function onWebChunk(sess, chunk) {
    try {
        if (gateFrameScopeMismatch(chunk)) return;
        /* file_changes 是 run 级被动快照：只更新独立持久卡，不得清等待指示器、推进
           currentRunId / activeRunId / phase，也不得重置静默计时。历史回放仍复用此入口。 */
        if (chunk.type === 'file_changes') {
            if (typeof window.onFileChangesChunk === 'function') window.onFileChangesChunk(sess, chunk);
            return;
        }

        /* 后台子代理进度心跳：与 file_changes 同级的纯被动帧，只改卡片头部的一行状态文本。
           必须在此短路，不得走下方的完整路径，否则会连带三件事：
           ① removeInlineThinking 会<b>闪掉主代理正在显示的内联思考指示器</b>（后台心跳频率
              极高，每个工具调用一次），主代理下一个帧到达才重建 → 可见的视觉抖动；
           ② 刷新 lastEventAt / 重置 silenceTimer：那是主流停滞检测的依据，而心跳反映的是
              <b>后台任务</b>的活性，拿它去喂主流的看门狗会掉真正的停滞信号；
           ③ 相位推进：心跳帧刻意不携带 phase（见 WebChunk.ofAgentProgress），但完整路径的
              inferPhaseFromType 降级推断仍可能改写 sess.phase，污染主对话指示器文案。 */
        if (chunk.type === 'agent_progress') {
            updateAgentProgress(sess, chunk);
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

        // 相位变化后，同步刷新「已经挂在页面上」的独立等待指示器（.thinking-row）文案。
        // 它在发送时就被创建（showThinking），文案取当时的相位（waiting），此后只有内容帧
        // 到达时才会被 removeThinking 整个移除 —— 于是一旦本轮不产出任何内容帧（如思维链被
        // 屏蔽的模型：思考真实发生但文本全空），它就会长期停在「等待响应」并持续累加计时。
        // 气泡内指示器（.inline-thinking）不在此处理：它每次显示都会重新 applyPhaseLabel。
        if (nextPhase && sess.thinkingEl && typeof applyPhaseLabel === 'function') {
            applyPhaseLabel(sess.thinkingEl, nextPhase);
        }

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
            case 'reason_start':
                // 新一轮模型调用开始：凭帧携带的 turnStartMs 提前作废旧一轮的定格耗时，
                // 让耗时行在本轮起步阶段就重新走表，而非停在上一轮定格值直到首个 context_size
                if (chunk.args && chunk.args.turnStartMs && typeof noteContextTurnStart === 'function') {
                    noteContextTurnStart(sess, chunk.args.turnStartMs);
                }
                break;
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
                // 外部处理器逐个隔离：否则单个处理器抛异常会让整个 onWebChunk 进入异常分支，后续渲染全停
                if (window._todoChunkHandlers) window._todoChunkHandlers.forEach(function(h){
                    try { h(chunk); } catch (e) { reportStreamPipelineError('todoChunkHandler', e, chunk); }
                });
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
            case 'action_batch': finishThinkingBlock(sess); clearRetryChunk(sess);
                // 批次声明帧：整批工具执行前一次性声明批次结构，收到即把已存在的成员骨架卡
                // 一次性收编进容器（消除「单卡先出 → 容器后到 → 逐张搬入」的中间态）。
                // 归属路由与 action_draft/action_start 完全对齐：子代理的容器必须落进它自己的卡片。
                var batchOwnerState = resolveAgentState(sess, chunk.args);
                if (batchOwnerState) { finishAgentThinkingBlock(sess, batchOwnerState); }
                applyActionBatchChunk(sess, chunk, batchOwnerState ? batchOwnerState.bodyEl : null);
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
    /* agent_start / agent_end 的收敛动作（finishThinkingBlock / finishPendingTool / clearRetryChunk）
       对<b>前台</b>子代理帧是正确的：它经父 sink 下发，此刻主代理正阻塞在 ACTION 段等它，
       主代理的思考/工具帧不可能同时到达，收敛不会误伤任何在途内容。
       但<b>后台</b>帧（args.background，由 WebGate 旁路推送）与主代理自己的流式帧必然交错——
       这正是「主代理提交后台任务后继续推进」的直接后果。此时若仍收敛，每来一个后台
       start/end 帧就会把主代理<b>正在输出</b>的思考块强制定稿（文案改「思考完成」、清计时器、
       清空 buffer），用户看到的是思考块被反复打断、内容撕裂成多条。 */
    case 'agent_start':
    case 'agent_end': {
        var isBgAgentFrame = !!(chunk.args && chunk.args.background);
        if (!isBgAgentFrame) {
            finishThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess);
        }
        appendAgentBadge(sess, chunk, chunk.type === 'agent_start');
        break;
    }
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
        // 后端解除挂起（切完全访问）：把对应审批卡收为「已放行」终态。
        // 回放同走此分支：已落盘的 hitl 帧重渲染出的卡会被紧随其后的释放帧收掉，
        // 历史里不再留可点的死卡（后端已无挂起任务，点批准只会 ACTION_MISMATCH）。
        case 'hitl_released': if (typeof releaseHitlCards === 'function') releaseHitlCards(sess, chunk.actionId || null); break;
        case 'question': finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendQuestionCard(sess, chunk); break;
        case 'question_answered': handleQuestionAnsweredFrame(sess, chunk); break;
            case 'trace':  finishThinkingBlock(sess); finishAgentThinkingBlock(sess); finishPendingTool(sess); clearRetryChunk(sess); appendTraceBadge(sess, chunk);
                // 任务耗时定格：trace 帧携带 TurnTimer 用单调时钟测得的权威 elapsedMs，
                // 与徒标显示的值同源。收口后停掉前端 tick，避免“已结束的轮还在走表”。
                // 必须晚于 appendTraceBadge：两者读同一个 chunk，顺序不影响数值，但保持
                // “先渲染徒标、后定格环”使异常时徒标（主展示）不会被连带拖垮。
                if (chunk.elapsedMs != null && typeof settleContextElapsed === 'function') {
                    settleContextElapsed(sess, chunk.elapsedMs);
                }
                break;
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
    } catch (e) {
        /* 不上抛（单帧出错不得拖垮整条流），但必须留痕。
           这里原本是个空捕获：一旦某个状态损坏让本函数稳定抛异常，内容帧会被逐条静默
           丢弃，而 done 帧走 dispatchGateChunk 前置分支不经过这里、照常收尾 —— 表现为
           「内容定格在中途、停止按钮却正常变回发送态」且零日志，无从排查。 */
        reportStreamPipelineError('onWebChunk', e, chunk);
    }
}

/* 挂起态 done：后端在等待用户作答/审批时也会发 done（WebStreamBuilder 在 question/hitl 帧之后紧跟一个 done）。
   它表达的是「本段流先停一下」而非「本轮真的结束」：恢复后同一批工具的剩余帧还会回来。
   若按普通 done 清掉 toolBatchesById/toolCardsById，恢复后的成员卡找不到原批次容器，同一批会被拆成两组渲染。
   辨识方式：优先用后端显式标记 chunk.suspended（WebGate 出站补打，见 line.setSuspended(true)）；
   旧后端无该字段时降级看本地相位——上一帧是 question/hitl 即为挂起（二者都紧跟 done）。 */

/* 全局发送按钮态与活动会话流式态的一致性收敛。所有「会话流式态翻转点」都必须经过这里：
 * finishStream 的真正收尾要经过上百行 DOM 清理（强刷渲染/高亮/批次扫尾/resetStreamState），
 * 若把按钮复位留在函数末尾，中段任何一步抛异常（异常被上层吞掉只留痕）都会让复位永远执行不到——
 * 表现为「任务已结束，按钮却停在停止态」，直到用户切换会话（setActiveSession 重置）才恢复。
 * 现约定：翻转点先同步全局态（本函数，零 DOM、不抛异常），DOM 收尾链再包异常防护。 */
function syncSendButtonToSessionState(sess) {
    if (!sess || !sess.sessionId || sess.sessionId !== activeSessionId) return;
    isStreaming = !!sess.isStreaming;
    if (isStreaming) setBtnStopMode();
    else setBtnSendMode();
}

function isSuspendedDone(sess, chunk) {
    if (chunk && chunk.suspended === true) return true;
    if (!sess) return false;
    return sess.phase === PHASE_QUESTION || sess.phase === PHASE_HITL;
}

// 侧边栏流式状态刷新定时器：streaming 期间每 30s 触发一次 updateHistoryUI，
// 保持时间小字与 spinner 的显示准确；无会话在 streaming 时自动停止。
var _sidebarRefreshTimer = null;
function ensureSidebarRefreshTimer() {
    if (_sidebarRefreshTimer) return;
    _sidebarRefreshTimer = setInterval(function() {
        if (typeof updateHistoryUI === 'function') updateHistoryUI();
    }, 30000);
}
function clearSidebarRefreshTimerIfIdle() {
    if (!_sidebarRefreshTimer) return;
    var _anyStreaming = false;
    if (window.sessionMap) {
        for (var _k in window.sessionMap) {
            if (window.sessionMap[_k] && window.sessionMap[_k].isStreaming) { _anyStreaming = true; break; }
        }
    }
    if (!_anyStreaming) {
        clearInterval(_sidebarRefreshTimer);
        _sidebarRefreshTimer = null;
    }
}

function finishStream(sess, opts) {
    // 挂起收尾：只停 UI 等待指示，不拆批次/卡片索引（它们要等恢复后的剩余帧来认领）。
    var keepBatchIndex = !!(opts && opts.keepBatchIndex);
    var wasStreaming = sess.isStreaming;
    sess.isStreaming = false;
    clearSidebarRefreshTimerIfIdle();
    sess.phase = PHASE_DONE;
    /* 【挂起标记】本次 done 是「等用户作答/审批」而非真结束：引擎随时会带【同一个 runId】继续跑。
       必须落盘给下游区分「收口」与「挂起」——变更卡片靠它避免在任务运行中就展示（见
       app-file-changes.js 的 runSettled）。isStreaming 单独不够用：挂起后它同样是 false。
       真收口时置 false（恢复后的那一轮 done 会重新走到这里）。 */
    sess._runSuspended = keepBatchIndex;
    if (sess.silenceTimer) { clearTimeout(sess.silenceTimer); sess.silenceTimer = null; }
    /* 按钮复位前置：本函数其余部分是一长段 DOM 收尾链，任何一步抛异常都会让原本排在
     * 末尾的复位永远执行不到（上层 onmessage/applySequencedGateChunk/drainGateBuffer 只
     * 留痕不上抛）。状态落盘与按钮复位必须原子化：状态一落盘，全局态立刻跟随。 */
    syncSendButtonToSessionState(sess);

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
    // 挂起收尾除外：参数生成期的骨架卡在恢复后会等到自己的 action_start，此刻删掉等于提前判死。
    if (!keepBatchIndex && typeof removeOrphanArgsStreamingCards === 'function') removeOrphanArgsStreamingCards(sess);

    // 普通工具卡可在流结束时视为完成；批量卡需留给下方批次完整性检查，缺帧时标黄。
    // 挂起收尾时不动 loading 态：那些工具真的还在「待执行」，标黄会谎报成执行失败。
    // 扫的是本轮内容所在的渲染落点：回放期收尾要清临时容器里刚重建的卡片，
    // 实时流期落点恒等于真实容器，行为与改造前一致。
    var finishRoot = renderRoot(sess);
    if (finishRoot && !keepBatchIndex) {
        $(finishRoot).find('.tool-card:not([data-batch-key]) .tool-status-icon.loading').each(function() {
            this.className = 'tool-status-icon warn';
            this.innerHTML = '';
        });
        // 同时清理残留的 loading 态子智能体状态点
        $(finishRoot).find('.agent-status-icon.loading').each(function() {
            this.className = 'agent-status-icon done';
        });
        // 移除残留的 .agent-card-streaming 类
        $(finishRoot).find('.agent-card-streaming').removeClass('agent-card-streaming');
        // 移除残留的 .streaming 思考块标记
        $(finishRoot).find('.thinking-block.streaming').removeClass('streaming');
    }

    sess.approvedToolCard = null;

    // 收尾批量分组状态：完整批次标记成功；缺 start/end 或无效槽位的批次标记 warning，
    // 避免流已结束仍保留闪烁 loading，也避免把缺帧批次误报为全部成功。
    if (sess.toolBatchesById && !keepBatchIndex) {
        Object.keys(sess.toolBatchesById).forEach(function(key) {
            var b = sess.toolBatchesById[key];
            if (!b || !b.groupEl) return;
            // 空容器（成员卡全部被孤儿清理 / 从未落卡）直接移除：空壳比不显示更误导，
            // 与「孤儿骨架卡是移除而不是标黄」同一哲学。
            if ($(b.groupEl).find('.tool-card').length === 0) {
                $(b.groupEl).remove();
                delete sess.toolBatchesById[key];
                return;
            }
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
    // 【C1-c】挂起态 done 不得清批次/卡片索引：恢复后同一批的 action_end 要靠 batchKey/actionId
    // 回到原容器，清掉则会另建一个批次容器，同一批被拆成两组渲染。
    if (!keepBatchIndex) {
        sess.toolBatchesById = {};
        sess.toolCardsById = {};
    }

    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }

    // 显示助手消息时间戳
    setAssistantTime(sess, sess._lastCreatedAt || Date.now());
    sess._lastCreatedAt = null;

    // 轮末收敛：把该轮变更卡片定位到本轮节点组末尾（流式中新节点可能晚于卡片到达）
    if (typeof window.repositionFileChangeCards === 'function') window.repositionFileChangeCards(sess);

    // 流式结束，显示复制按钮（流式过程中被隐藏）
    if (sess.currentBubbleEl) {
        var doneRow = $(sess.currentBubbleEl).closest('.msg-row')[0];
        if (doneRow) $(doneRow).find('.msg-actions').show();
    }

    // resetStreamState 会清空 buffer，所以必须在上面强刷完后再调
    // 挂起收尾：completedActionIds 是「同一 actionId 不重复建卡」的幂等依据，被 resetStreamState
    // 一并清掉后，恢复后重发的同批帧会再建一遍已有的卡。先快照再原样回填。
    var keptCompletedActionIds = keepBatchIndex ? sess.completedActionIds : null;
    resetStreamState(sess);
    if (keepBatchIndex) sess.completedActionIds = keptCompletedActionIds || {};

    /* DOM 收尾链异常防护：本段（purgeEmptyMdBlocks 起至函数末尾）任何一步抛异常，
     * 都不得再让全局按钮态与会话态背离——异常只留痕，尾部不再有必须执行的复位。 */
    try {
        // 清扫遗留的视觉为空正文容器，统一卡片间隔（指针推进遗留的空 .md-content 会撑出参差间距）
        purgeEmptyMdBlocks(renderRoot(sess));
    } catch (e) { reportStreamPipelineError('finishStream:purge', e, null); }

    if (sess.sessionId === activeSessionId) {
        isStreaming = false;
        setBtnSendMode();
        // 非 force：用户若已上滚查看历史（任务运行期间常见），done 帧不得把视口抢回底部；
        // 回放收尾（_skipScroll）时由回放层自行控制滚动
        try {
            if (!sess._skipScroll) scrollToBottom();
            chatInput.focus();
        } catch (e) { reportStreamPipelineError('finishStream:tail', e, null); }
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

/* ===== WebSocket 连接池（多远端并发，契约 §3） =====

   为什么必须是池而不是单例：旧实现全站只有一个 webGateSocket，且 connectWebGate
   在重建前会 close 旧连接。用户「选本地工作区跑一个长任务、同时选远端工作区跑另一个」
   时，切工作区就把仍在收帧的旧连接掐了——旧任务的事件流当场断掉（只能靠 HTTP replay
   补，而 replay 只补历史、补不上正在实时产生的帧的连续性）。并发的核心就是
   【切工作区不关旧 socket】，每个环境各留一条自己的长连接。

   key = scopeKey：'local'（本地后端）| 'id:<connectionId>'（某条远程连接的隧道上游）。
   Rust 侧 route_for 第 2 级 ?__scope=id:<rid> 对 WS 升级面同样生效（server.rs:232-251+769），
   凭据注入（server.rs:812-834）已就绪，故前端只需把归属拼进 URL。 */
var gateSockets = new Map();
/* 池上限 4 条：每条连接在后端都占一个 WebSocket 注册项与一份心跳开销，
   而用户同时真正在跑任务的环境极少超过 3 个（本地 + 两台远端）。
   超出按 LRU 关最久无帧者（契约 §3.4）。 */
var GATE_POOL_MAX = 4;
/* 空闲回收阈值：该 scope 无 running 会话、又不是当前选中环境、且 90s 没收到任何帧
   → 回收（契约 §3.4 的防泄漏定时器）。90s 远大于单帧间隔，不会误杀活跃流。 */
var GATE_IDLE_RECLAIM_MS = 90000;
/* 回收巡检周期：30s 一轮（与侧栏刷新定时器同档，开销可忽略）。 */
var GATE_RECLAIM_TICK_MS = 30000;
var webGateReconnectAttempts = 0;
var webGateHeartbeatTimer = null;
var webGateReclaimTimer = null;
/* 僵尸连接检测：连续未收到 pong 的心跳周期数（见 startWebGateHeartbeat 的注释）。

   池化后真实计数按桶存 entry.pongMisses（各桶的半开状态互不相干，用全局单计数会
   互相清零：A 桶回了 pong 就把 B 桶的僵尸证据抹掉，B 桶永不重连）。
   本全局变量保留为【local 桶的全局镜像】：诊断出口 window.__gourdGateDiag() 读它，
   且既有僵尸检测契约测试（zombie-conn-detection.test.js）锁的是这些字面量。 */
var webGatePongMisses = 0;
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

/* ---------- 归属（scope）推导：池的 key 从哪来 ---------- */

/* 多连接读口（契约 §2.2，由 app-remote.js 暴露）。取不到返回 null：
   浏览器直开（gwork web 0）与无壳环境下 __GOURD_REMOTE__ 根本不存在，此时全站
   降级为「只有 local 一个桶」= 改造前的单 socket 行为，不报错也不误路由。 */
function gateRemoteRegistry() {
    var r = window.__GOURD_REMOTE__;
    return (r && typeof r.list === 'function') ? r : null;
}

/* 归一化 scopeKey：'local' | 'id:<rid>'。
   入参容忍三种形态（调用方历史包袱）：'id:x' / '?__scope=id:x' / '&__scope=id:x' /
   'local' / 空。空与 local 都归 'local'。 */
function gateScopeKeyOf(scopeQ) {
    var s = String(scopeQ == null ? '' : scopeQ).trim();
    if (!s) return 'local';
    var at = s.indexOf('__scope=');
    if (at >= 0) s = s.slice(at + '__scope='.length);
    s = s.split('&')[0].split('?')[0];
    if (!s || s === 'local') return 'local';
    if (s.indexOf('id:') === 0) return 'id:' + decodeURIComponent(s.slice(3));
    /* 裸 connectionId（无 id: 前缀）也接住：调用方可能直接传 rid。 */
    return 'id:' + s;
}

/* scopeKey → 拼进 gate URL 的 query 段（'local' 不拼：Rust route_for 对无 scope 的
   WS 走 ?cwd= 归属分流，与改造前逐字节一致，老壳/浏览器直开零行为差）。 */
function gateScopeQueryOf(scopeKey) {
    if (!scopeKey || scopeKey === 'local') return '';
    return '?__scope=id:' + encodeURIComponent(scopeKey.slice(3));
}

/* 该连接是否仍在线（契约 §2.2 的 list()）。降级：无注册表时一律视为在线
   ——local 桶本就与远程连接无关；而拿不到 list() 也无从判定，保守留活。 */
function gateScopeAlive(scopeKey) {
    if (!scopeKey || scopeKey === 'local') return true;
    var reg = gateRemoteRegistry();
    if (!reg) return true;
    var rid = scopeKey.slice(3);
    var arr = [];
    try { arr = reg.list() || []; } catch (e) { return true; }
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].connectionId === rid) return true;
    }
    return false;
}

/* 真子目录判定：child 是否位于 parent 目录【之内】（不含相等，相等由调用方另行 OR）。
   WHY 必须判分隔符边界：裸 indexOf 前缀匹配会把 d:\work\proj2 误判成 d:\work\proj
   的子目录——两个毫不相干的项目归到同一个桶，帧过滤与空闲回收判定会跟着一起错。 */
function gatePathUnderDir(child, parent) {
    if (!child || !parent || child.indexOf(parent) !== 0) return false;
    var sep = child.charAt(parent.length);
    return sep === '\\' || sep === '/';
}

/* 路径 → 桶归属的自足推导（权威接口不可用时的兜底）：按池里各桶【建连时的 cwd 快照】
   做目录边界前缀匹配。

   onlyRemote=true（帧过滤用）时跳过 local 桶。WHY：两台机器上存在同名路径是真实场景
   （契约 §4.3 专门为此把去重键叠了 scope），此时「路径落在 local 桶的 cwd 之下」是
   弱证据，拿它去否掉一条从 id:<rid> 桶收到的帧 = 远端内容永久缺失且无从复现；
   而漏过滤只是多一帧重复，有滑窗指纹去重兜底。宁可漏过滤，绝不误杀。 */
function gateScopeKeyByCwd(path, onlyRemote) {
    var pk = (typeof pathScopeKey === 'function') ? pathScopeKey(path) : String(path == null ? '' : path);
    if (!pk) return null;
    var it = gateSockets.entries ? gateSockets.entries() : null;
    if (!it) return null;
    var step = it.next();
    while (!step.done) {
        var e = step.value[1];
        var k = step.value[0];
        if (e && e.cwdKey && !(onlyRemote && k === 'local')
                && (pk === e.cwdKey || gatePathUnderDir(pk, e.cwdKey))) return k;
        step = it.next();
    }
    return null;
}

/* 当前视图应落在哪个桶（= 用户此刻选中的环境）。

   优先级：① 契约 §8 的两个 strict 归属读口（code 模式 __currentProjectScope /
   chat 模式 __currentChatWorkspaceScope，查不到返回 null 或 'local'，绝不回落激活连接）；
   ② 自足推导（池内 cwd 快照匹配）；③ 'local'。

   WHY 不用 app-workspace 的 scopeOfPath：它是 IIFE 闭包内的私有函数，全仓从未挂到
   window 上（只有 §8 的 __currentChatWorkspaceScope 是导出面）。按它取归属恒为
   undefined，于是远端工作区被判成本地 → 所有环境共用一个 'local' 桶 → per-scope
   池退化成单例，正是本契约要消灭的形态。

   WHY code 与 chat 两个读口互斥、不串用：二者读的是不同变量（currentProjectRoot /
   currentChatWorkspace），code 模式下 currentChatWorkspace 可能是上一次 chat 的残留，
   串用会把终端与事件流指到另一台机器。

   为什么不能直接拿 __GOURD_REMOTE_ACTIVE_ID__()：它回答的是「有没有连着远端」，
   而并存语义下用户完全可能连着远端却在本地工作区干活——拿它当归属会把本地会话的
   事件流打到远端隧道（跳机聊）。查不到一律回 local（默认环境就是本地）。 */
function currentGateScopeKey() {
    /* 降级门（契约 §3：无多连接读口时优雅退回单 socket 旧行为）。
       WHY 必须前置：浏览器直开/无壳环境下 __GOURD_REMOTE__ 根本不存在，此时若某个
       scope 读口给出残留的远端 id（app-workspace 的项目缓存未清、页面重载前写入的
       localStorage 选择），建出的 id:<rid> 桶会带上代理无从路由的 __scope 参数，
       结果是长连接落到错误上游或直接建不起来——而这类环境本就只可能有本地后端。 */
    if (!gateRemoteRegistry()) return 'local';
    var cwd = (typeof getSessionCwd === 'function') ? (getSessionCwd() || '') : '';
    if (!cwd) return 'local';
    if (window.appMode === 'code') {
        /* ① code 模式：当前项目根的 strict 归属（app-code 暴露，列表未加载时返回 null） */
        if (typeof window.__currentProjectScope === 'function') {
            var cs = null;
            try { cs = window.__currentProjectScope(); } catch (e) { cs = null; }
            if (cs && cs !== 'local') return 'id:' + cs;
            if (cs === 'local') return 'local';
        }
    } else if (typeof window.__currentChatWorkspaceScope === 'function') {
        /* ① chat 模式：当前选中工作区的 strict 归属（app-workspace 暴露，契约 §8） */
        var ws = null;
        try { ws = window.__currentChatWorkspaceScope(); } catch (e) { ws = null; }
        if (ws && ws !== 'local') return 'id:' + ws;
        if (ws === 'local') return 'local';
    }
    /* ② 自足推导：项目登记表还没加载完（① 返回 null）时，按池内 cwd 快照兜住。
       这里允许匹配 local 桶——判定对象是【用户当前选中的目录】，不存在跨机同名歧义。 */
    var byCwd = gateScopeKeyByCwd(cwd, false);
    if (byCwd) return byCwd;
    /* ③ 无注册表（浏览器直开/无壳）：恒 local —— 单桶 = 改造前的单 socket 行为。 */
    return 'local';
}

/* 帧的归属（契约 §3.3 双保险）：sessionId → sessionMap[sid].projectRoot → scope。
   返回 null 表示【归属未知】——调用方必须放行而非丢弃：
   各 socket 本就只收自己 scope 的帧（Rust 按 __scope/cwd 分流），此处只是双保险；
   而误杀帧的代价（内容永久缺失）远高于漏过滤（滑窗指纹去重会吃掉重复帧）。 */
function gateChunkScopeKey(chunk) {
    if (!chunk) return null;
    var sid = chunk.sessionId;
    if (!sid) return null;                      // 系统级广播（filer_change 等）无归属，放行
    var sess = sessionMap[sid];
    if (!sess) return null;                     // 会话未建：交回原路径建会话，不在此拦
    /* ① 会话自带归属标记：确定事实，直接采信（契约 §3.3） */
    if (sess._scope) return (sess._scope !== 'local') ? 'id:' + sess._scope : 'local';
    var root = sess.projectRoot || '';
    /* ② 无 projectRoot = 全局区会话。此处绝不能断言 'local'：远端同样有全局会话
       （契约 §5.3「不选工作区的远端对话」），它们的帧恰恰只从 id:<rid> 桶来；
       断言 local 会把这些帧全部当异源丢掉，表现为「远端全局对话一个字都不出」。 */
    if (!root) return null;
    /* ③ 该会话正是当前选中的工作区/项目：用 ① 级权威口径判定（发送链路与它同源，
       判定结果与帧的实际来源桶必然一致）。 */
    var cur = (typeof getSessionCwd === 'function') ? (getSessionCwd() || '') : '';
    if (cur) {
        var same = (typeof pathScopeKey === 'function')
            ? (pathScopeKey(root) === pathScopeKey(cur))
            : (root === cur);
        if (same) return currentGateScopeKey();
    }
    /* ④ 其它历史会话：登记表在 app-workspace/app-code 的闭包里，本模块拿不到逐路径
       归属，只能靠池内 cwd 快照兜（且只认远端桶，理由见 gateScopeKeyByCwd）。
       匹配不上就返回 null 放行——双保险宁可不生效，也不能反向误杀。 */
    return gateScopeKeyByCwd(root, true);
}

/* 该桶是否有正在跑的会话（回收判定用）：按 projectRoot 归属比对。 */
function gateScopeHasRunningSession(scopeKey) {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var sess = sessionMap[sid];
        if (!sess || !sess.isStreaming) continue;
        var k = gateChunkScopeKey({ sessionId: sid });
        if (k === null) {
            /* 归属未知：保守当作「本桶可能在跑」，绝不回收（宁可多留一条连接，
               也不能把正在收帧的通道掐了）。 */
            if (scopeKey === currentGateScopeKey()) return true;
            continue;
        }
        if (k === scopeKey) return true;
    }
    return false;
}

function gateEntry(scopeKey) {
    return gateSockets.get(scopeKey) || null;
}

function gateSocketOf(scopeKey) {
    var e = gateEntry(scopeKey);
    return e ? e.socket : null;
}

function gateSocketAlive(scopeKey) {
    var s = gateSocketOf(scopeKey);
    return !!(s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING));
}

// 用户主动发起会话时确保【该会话所属环境】的连接就绪：若已断且退避已停止，
// 则重置该桶计数并立即重连。scopeQ 可选（不传按当前视图归属推导）。
function ensureWebGateConnected(scopeQ) {
    var scopeKey = gateScopeKeyOf(scopeQ) || currentGateScopeKey();
    if (gateSocketAlive(scopeKey)) return;
    var e = gateEntry(scopeKey);
    if (e) e.reconnectAttempts = 0;
    else webGateReconnectAttempts = 0;
    connectWebGate(scopeQ);
}
window.ensureWebGateConnected = ensureWebGateConnected;
/* 远程工作区（P0-2 修复）：远程连接建立/断开时，本地 UI 服务器的 WS 代理上游
   已切换（远端隧道 ⇄ 本地后端），指向已失效上游的那条连接必须重建。
   由 app-remote.js 的 applyConnection/doDisconnect 调用（远程徽标/菜单同链路）。

   池化后的语义变化（契约 §3.4）：connectWebGate 只保证【目标桶】连接就绪，
   绝不动其它桶——切工作区不关旧 socket 正是并发的核心。真正会 close 的只有
   三处：连接死亡（remote:connections-changed）、空闲回收、LRU 超限，
   全部收敛在 closeGateSocket 这一个出口里。 */
window.connectWebGate = connectWebGate;
/* 诊断出口：现场自查连接池形态（每桶的 readyState / 最近帧时间 / pong 缺失数）。 */
window.__gourdGateDiag = function() {
    var out = { poolMax: GATE_POOL_MAX, pongMisses: webGatePongMisses, entries: [] };
    var it = gateSockets.values ? gateSockets.values() : null;
    if (!it) return out;
    var step = it.next();
    while (!step.done) {
        var e = step.value;
        out.entries.push({
            scopeKey: e.scopeKey,
            readyState: e.socket ? e.socket.readyState : -1,
            pongMisses: e.pongMisses || 0,
            reconnectAttempts: e.reconnectAttempts || 0,
            idleMs: e.lastFrameAt ? (Date.now() - e.lastFrameAt) : -1
        });
        step = it.next();
    }
    return out;
};

/* 建桶（幂等）：每个 scopeKey 一份连接台账。 */
function ensureGateEntry(scopeKey) {
    var e = gateSockets.get(scopeKey);
    if (!e) {
        e = {
            scopeKey: scopeKey,
            socket: null,
            cwd: '',
            cwdKey: '',
            createdAt: Date.now(),
            lastFrameAt: Date.now(),   // LRU 与空闲回收的依据（最久无帧者先汰）
            lastUsedAt: Date.now(),
            pongMisses: 0,
            reconnectAttempts: 0,
            reconnectTimer: null,
            reclaiming: false
        };
        gateSockets.set(scopeKey, e);
    }
    return e;
}

/* 摧销连接对象：先摘全部回调再 close。
   为什么要先摘回调：新旧连接并存期间，旧连接的残帧会继续进入 onmessage（重复推送），
   旧 onclose 还会误终结新连接的流并触发一次多余重连。
   全文件只有本函数与僵尸分支的 dead.close() 两个 close 出口（契约 §6：
   close 调用点仅得出现在回收/断连分支）——切工作区绝不经过这里。 */
function retireGateSocket(entry) {
    var s = entry ? entry.socket : null;
    if (entry) entry.socket = null;
    if (!s) return;
    try {
        s.onopen = null;
        s.onmessage = null;
        s.onclose = null;
        s.onerror = null;
        s.close();
    } catch (e) { /* 退役异常忽略 */ }
}

/* 关连接的唯一业务出口（契约 §3.4 的三个时机均经此）：
   ① 连接死亡（remote:connections-changed 的 detail.ids 不含该 id）；
   ② 空闲 >90s 且无 running 会话且非当前选中；③ 池超上限 4 条的 LRU。
   先摘池再 close：使该 socket 的 onclose 里「仍在池中」判定失效，
   否则被回收的连接会被自己的 onclose 立刻重建（泄漏 + 与 LRU 打架）。 */
function closeGateSocket(scopeKey, reason) {
    var entry = gateSockets.get(scopeKey);
    gateSockets.delete(scopeKey);
    if (!entry) return;
    entry.reclaiming = true;
    if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
    retireGateSocket(entry);
    stopWebGateHeartbeatIfIdle();
    console.log('[WebGate:' + scopeKey + '] closed (' + (reason || 'reclaim') + ')');
}
window.__gourdCloseGateSocket = closeGateSocket;   // 诊断/测试出口

/* 会话 → 所属桶（发送/恢复/重连均按它取连接，不再看全局当前视图）。
   为什么必需：发消息的 cwd 取 sess.projectRoot（而非当前视图），而事件流必须
   回到同一个上游，否则就是「发消息到远端、事件流回本地」的断链。 */
function sessionGateScopeKey(sess) {
    if (!sess) return currentGateScopeKey();
    var k = gateChunkScopeKey({ sessionId: sess.sessionId });
    return (k === null) ? currentGateScopeKey() : k;
}

// 连接断开时保留当前消息 DOM 和流式状态，重连后按 eventSeq 补回缺失事件。
/* scopeKey（可选）：只标记属于该桶的会话。为什么必须过滤：池化后一条远端连接断开
   不得把本地会话一并标成 _recovering——那会让本地会话的实时帧全被压进 _gateBuffer
   等一个永不会来的 replay（UI 当场停摆）。不传 = 全量（与改造前逐字一致）。 */
function markStreamingSessionsForRecovery(scopeKey) {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var sess = sessionMap[sid];
        if (sess && sess.isStreaming) {
            if (scopeKey && sessionGateScopeKey(sess) !== scopeKey) continue;
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
    /* 游标推进必须包在 finally 里：旧实现把推进写在 dispatch 之后，一旦 dispatch 抛异常
       （异常又被上层捕获），游标就停在原地：同一帧会被后续恢复/排空路径反复重放，
       每次重放又抛在同一处，形成原地死循环；而它之后的帧永远轮不上。
       帧已经消费过就算数（成败都算），否则一个损坏帧能卡死整条流。 */
    try {
        dispatchGateChunk(chunk);
    } catch (e) {
        reportStreamPipelineError('applySequencedGateChunk', e, chunk);
    } finally {
        if (seq) sess.lastEventSeq = Math.max(sess.lastEventSeq || 0, seq);
    }
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
                && gateSocketAlive(sessionGateScopeKey(sess))) {
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
            ensureSidebarRefreshTimer();
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

/* scopeKey（可选）：只恢复属于该桶的会话。onopen 传本桶 key：远端桶重连不该给本地
   会话发 replay（反之亦然），否则两边互相触发无用请求且可能交错推进游标。
   不传 = 全量（与改造前一致）。recoverStreamingSession 的 HTTP replay 本体零改动（契约 §3.6）。 */
function recoverStreamingSessions(scopeKey) {
    for (var sid in sessionMap) {
        if (!sessionMap.hasOwnProperty(sid)) continue;
        var sess = sessionMap[sid];
        if (scopeKey && sessionGateScopeKey(sess) !== scopeKey) continue;
        recoverStreamingSession(sess);
    }
}

/* 连接池上限守门（契约 §3.4）：超过 4 条时按 LRU 关最久无帧者。
   两条硬红线：刚建的桶（protectScopeKey）绝不汰；有 running 会话的桶绝不汰
   （正在收帧的通道掐了就是丢内容，宁可瞬时超限也不能杀活流）。 */
function enforceGatePoolLimit(protectScopeKey) {
    if (gateSockets.size <= GATE_POOL_MAX) return;
    var current = currentGateScopeKey();
    var cands = [];
    gateSockets.forEach(function(e, k) {
        if (!e || k === protectScopeKey) return;
        if (gateScopeHasRunningSession(k)) return;
        // 当前选中环境排到最后（加一个远超时间戳量级的偏置），但不绝对豁免：
        // 若只剩它可汰且仍超限，宁可关它也不能让池无限长（它下次发送会自建）。
        var bias = (k === current) ? 1e15 : 0;
        cands.push({ k: k, score: (e.lastFrameAt || e.createdAt || 0) + bias });
    });
    cands.sort(function(a, b) { return a.score - b.score; });   // 最久无帧者在前
    var over = gateSockets.size - GATE_POOL_MAX;
    for (var i = 0; i < over && i < cands.length; i++) closeGateSocket(cands[i].k, 'pool-limit');
}

/* 空闲回收（契约 §3.4 第二个时机）：该桶无 running 会话 + 非当前选中 + 空闲 >90s。
   存在的理由：并发池只开不关会泄漏——用户依次选过 4 个环境后即使都不再跑任务，
   4 条连接与 4 份心跳会常驻到刷新页面。 */
function reclaimIdleGateSockets() {
    var now = Date.now();
    var current = currentGateScopeKey();
    var victims = [];
    gateSockets.forEach(function(e, k) {
        if (!e || k === current) return;
        if (gateScopeHasRunningSession(k)) return;
        var idle = now - (e.lastFrameAt || e.createdAt || now);
        if (idle < GATE_IDLE_RECLAIM_MS) return;
        victims.push(k);
    });
    for (var i = 0; i < victims.length; i++) closeGateSocket(victims[i], 'idle>' + GATE_IDLE_RECLAIM_MS + 'ms');
}

/* 连接死亡摘除（契约 §3.4 第一个时机）。
   aliveIds 传数组时以事件载荷为准（remote:connections-changed 的 detail.ids）；
   不传时走 __GOURD_REMOTE__.list() 交叉（定时兽底，防事件丢失）。
   降级：无注册表时 gateScopeAlive 恒 true → 一条也不摘（浏览器直开本就只有 local 桶）。
   local 桶与远程连接生死无关，永不在此摘除。 */
function pruneDeadGateScopes(aliveIds) {
    var victims = [];
    gateSockets.forEach(function(e, k) {
        if (!k || k === 'local') return;
        var rid = k.slice(3);
        var alive = aliveIds ? (aliveIds.indexOf(rid) >= 0) : gateScopeAlive(k);
        if (!alive) victims.push(k);
    });
    for (var i = 0; i < victims.length; i++) closeGateSocket(victims[i], 'connection-dead');
}
window.addEventListener('remote:connections-changed', function(ev) {
    try {
        pruneDeadGateScopes((ev && ev.detail && ev.detail.ids) || null);
    } catch (e) { /* 摘除失败不得影响其它监听者 */ }
});

/* 回收巡检定时器（首个连接建立时启动，幂等）：兼做三件事。
   为何需要定时兽底而不只靠事件：半开连接的 close() 可能连 onclose 都触发不了，
   而 remote:connections-changed 也可能因页面隐藏期间的事件丢失而错过。 */
function startGateReclaimTimer() {
    if (webGateReclaimTimer) return;
    webGateReclaimTimer = setInterval(function() {
        try {
            reclaimIdleGateSockets();
            pruneDeadGateScopes(null);
            scheduleWebGateReconnect();   // 无参 = 全池口径：为已无活连接的桶各自补一次退避
        } catch (e) { reportStreamPipelineError('gateReclaimTick', e, null); }
        if (!gateSockets.size && webGateReclaimTimer) {
            clearInterval(webGateReclaimTimer);
            webGateReclaimTimer = null;   // 池空自停，不留空转定时器
        }
    }, GATE_RECLAIM_TICK_MS);
}

/* 当前帧的来源桶（onmessage 分发前设置，分发后复位）。
   为何用模块变量而不改签名：onWebChunk(sess, chunk) 的签名被 app-history.js 的
   HTTP 回放路径共用（回放帧不经 WS，此值为 null → 不参与过滤），改签名会连带
   回放主链语义（契约 §3.6 禁止）。 */
var gateRxScopeKey = null;

function connectWebGate(scopeQ) {
    /* scopeQ（可选，契约 §3.2）：'id:<rid>' / '?__scope=id:<rid>' / '&__scope=id:<rid>' / 'local'。
       不传时按【当前视图归属】推导（currentGateScopeKey）：无多连接注册表（浏览器直开/
       无壳环境）时它恒返回 'local' → 全站只有一个桶 + 现 cwd 逻辑 = 改造前的单连接行为。 */
    var scopeKey = (scopeQ == null || scopeQ === '')
        ? currentGateScopeKey()
        : gateScopeKeyOf(scopeQ);
    var entry = gateSockets.get(scopeKey) || null;
    // 已连接或正在连接则跳过，避免重复建连。
    // （桌面端就绪时 __whenBackendReady 与 onBackendReady 会同一时刻各触发一次，
    //   此刻 socket 处于 CONNECTING 而非 OPEN，必须一并拦住，否则会建出两个连接。）
    if (entry && entry.socket &&
        (entry.socket.readyState === WebSocket.OPEN || entry.socket.readyState === WebSocket.CONNECTING)) {
        entry.lastUsedAt = Date.now();
        return;
    }
    /* 【池化后的关键语义变化】此处只退役【本桶】已死（CLOSING/CLOSED）的 socket，
       绝不关其它桶——切工作区不关旧 socket 正是并发的核心（契约 §3.4）：
       旧环境里正在跑的长任务靠它那条连接持续收帧，关掉就只能靠 HTTP replay 补历史。 */
    if (entry && entry.socket) retireGateSocket(entry);
    var socket;
    /* cwd 取值分两种情形（池化后新增的关键约束）：
       · 本桶就是【当前视图】：照旧取 getSessionCwd()（与改造前逐字一致）。
       · 本桶是后台桶（用户已切到别的环境，这条连接靠心跳/退避自行重连）：沿用建桶时的
         cwd 快照。WHY：getSessionCwd() 读的是单值当前视图，此刻它属于另一个环境；
         拿它当本桶的 cwd 会把【别的机器/别的目录】的路径写进本桶的 cwdKey 快照，而 cwdKey
         正是 gateScopeKeyByCwd 的帧过滤依据——污染后本地会话的 projectRoot 会匹配上
         这个远端桶，帧被判成异源而永久丢弃（远端内容消失且无从复现）。 */
    var isCurrentScope = (scopeKey === currentGateScopeKey());
    var gateCwd = '';
    try {
        // 同源 WebSocket：
        // - 浏览器模式（gwork web 0）：直连 jar 自身。
        // - 桌面端（Electron）：页面来自本地 UI 服务器 http://localhost:{uiPort}，
        //   该服务器把 /web/gate 反向代理到后端 jar，故同样用同源地址即可。
            var protocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
            // 后台桶沿用快照，当前桶取实时 cwd（WHY 见本函数开头的 cwd 取值说明）
            gateCwd = (!isCurrentScope && entry && entry.cwd) ? entry.cwd
                : ((typeof getSessionCwd === 'function') ? (getSessionCwd() || '') : '');
            var wsUrl = protocol + '//' + window.location.host + '/web/gate'
                + (gateCwd ? ('?cwd=' + encodeURIComponent(gateCwd)) : '');
            /* 再叠一层显式归属（契约 §3.2）：Rust route_for 第 2 级 ?__scope=id:<rid>
               对 WS 升级面同样生效（server.rs:232-251 + 769），优先级高于 cwd 归属分流。
               为何不能只靠 ?cwd=：远端【全局会话】（未选工作区）无 cwd 可带，只能落到
               代理的激活 scope 兑底——而激活会随用户选择漂移，同一会话的帧会在两台机器
               之间跳。local 桶不拼 scope 段：保持无参形态，URL 与改造前逐字节相同。 */
            var scopeSeg = gateScopeQueryOf(scopeKey);
            if (scopeSeg) wsUrl += (wsUrl.indexOf('?') >= 0 ? '&' : '?') + scopeSeg.slice(1);
        socket = new WebSocket(wsUrl);
    } catch(e) {
        console.error('[WebGate:' + scopeKey + '] create failed:', e);
        scheduleWebGateReconnect(scopeKey);
        return;
    }

    entry = ensureGateEntry(scopeKey);
    entry.socket = socket;
    /* 快照只在【当前视图】时刷新：后台桶重连沿用它自己的历史 cwd（理由见上）。
       gateCwd 为空时不清空既有快照——全局区建桶本就没有 cwd，但用户先选了工作区
       再回到全局区时，清掉快照会让帧过滤失去唯一的兜底依据。 */
    if (isCurrentScope || !entry.cwdKey) {
        entry.cwd = gateCwd;
        entry.cwdKey = gateCwd ? ((typeof pathScopeKey === 'function') ? pathScopeKey(gateCwd) : gateCwd) : '';
    }
    entry.createdAt = Date.now();
    entry.lastFrameAt = Date.now();
    entry.lastUsedAt = Date.now();
    entry.pongMisses = 0;
    entry.reclaiming = false;
    if (scopeKey === 'local') webGatePongMisses = 0;
    enforceGatePoolLimit(scopeKey);
    startGateReclaimTimer();

    socket.onopen = function() {
        if (gateSockets.get(scopeKey) !== entry) return;   // 建连期间已被回收：不接管
        console.log('[WebGate:' + scopeKey + '] connected');
        entry.reconnectAttempts = 0;
        if (scopeKey === 'local') webGateReconnectAttempts = 0;
        entry.lastFrameAt = Date.now();
        startWebGateHeartbeat();
        /* 重连后刷新文件树——但只当本桶就是【当前选中环境】：池化后后台桶也会连上，
           而文件树只展示当前工作区，让远端桶的 onopen 去刷会把本地目录顶掉。 */
        if (scopeKey === currentGateScopeKey() && typeof loadTree === 'function') {
            loadTree();
        }
        recoverStreamingSessions(scopeKey);
    };

    socket.onmessage = function(event) {
        // 被退役旧连接的残帧直接丢弃（新旧连接并存的重复推送残留通路）
        if (event.target && entry.socket && event.target !== entry.socket) return;
        // 本桶已被回收/顶替：连接对象还在飞但已不属于池，残帧一律丢弃
        if (gateSockets.get(scopeKey) !== entry) return;
        var raw = event.data;
        entry.lastFrameAt = Date.now();
        if (raw === 'pong') {
            // 心跳回复：连接健康，重置僵尸检测计数（见 startWebGateHeartbeat）
            entry.pongMisses = 0;
            webGatePongMisses = 0;
            return;
        }
        try {
            var chunk = JSON.parse(raw);
            // 任何业务帧同样证明连接活着，一并清零（防止高频帧期 pong 交错导致误判）
            entry.pongMisses = 0;
            webGatePongMisses = 0;

            /* 【契约 §3.3 双保险】按 sessionId → sessionMap[sid].projectRoot → scope 过滤：
               与本桶归属不符的帧忽略。各 socket 本就只收自己 scope 的帧（Rust 按
               __scope/cwd 分流），此处防的是同一后端被两条连接覆盖时的串流。
               返回 null = 归属未知（会话未建 / 无 projectRoot / 无 scopeOfPath 接口），必须放行：
               误杀帧 = 内容永久缺失，而重复帧有下方滑窗指纹去重兑底。 */
            var chunkScope = gateChunkScopeKey(chunk);
            if (chunkScope !== null && chunkScope !== scopeKey) return;

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
                /* 标记帧的来源桶：onWebChunk 入口的双保险过滤读它。用模块变量而不改
                   onWebChunk 签名：那个签名被 app-history.js 的 HTTP 回放路径共用，
                   回放帧不经 WS（此值为 null → 不参与过滤），改签名会连带回放主链语义。 */
                gateRxScopeKey = scopeKey;
                try {
                    applySequencedGateChunk(gateSess || getOrCreateSession(chunk.sessionId), chunk);
                } finally {
                    gateRxScopeKey = null;
                }
                return;
            }
            if (gateSess && gateSess._replayCoverage && replayCoverageHas(gateSess._replayCoverage, chunk)) return;

            gateRxScopeKey = scopeKey;
            try {
                dispatchGateChunk(chunk);
            } finally {
                gateRxScopeKey = null;
            }
        } catch(e) {
            /* 非 JSON 消息（心跳等）正常忽略；但 JSON.parse 成功后的异常是真故障，必须留痕。
               二者原本被同一个空捕获吞掉，使「帧已送达但渲染失败」与「根本不是业务帧」无法区分。
               首字符判定用 charCodeAt(0)===123 而不用 ===左花括号字面量：本函数会被仓库里
               多处「花括号配对切片器」（如契约测试的 cutFn）按字符扫描提取函数体，
               函数体内出现裸的左花括号字符串字面量会让配对计数失衡（净多一个开括号），
               切片器就找不到函数结尾——这是既有约定，凡被切片的函数体都不得含裸花括号字面量。 */
            if (raw && typeof raw === 'string' && raw.charCodeAt(0) === 123) {
                reportStreamPipelineError('webGateSocket.onmessage', e, null);
            }
        }
    };

    socket.onclose = function() {
        /* 本桶已摘池（主动回收/退役）或已被新连接顶替：不得再走重连与恢复标记，
           否则被回收的连接会被自己的 onclose 立刻重建（泄漏 + 与 LRU 打架）。 */
        if (gateSockets.get(scopeKey) !== entry || entry.socket !== socket) return;
        console.log('[WebGate:' + scopeKey + '] closed');
        entry.socket = null;
        entry.pongMisses = 0;
        if (scopeKey === 'local') webGatePongMisses = 0;
        stopWebGateHeartbeatIfIdle();
        // 保留流式上下文（仅本桶所属会话），等待新连接通过 replay 精确补流。
        markStreamingSessionsForRecovery(scopeKey);
        scheduleWebGateReconnect(scopeKey);
    };

    socket.onerror = function(err) {
        console.error('[WebGate:' + scopeKey + '] error:', err);
    };
}

/* gate 帧业务分发体（模块级全局：onmessage 与 app-history.js 的 drainGateBuffer 回放缓冲排空共用） */
/* 空闲态下的后台子代理帧安全消费。

   返回 true  = 已就地处理，调用方应 return；
   返回 false = 交回原路径（会话未建 / 流式中 / 回放中，原路径工作正常）。

   存在理由：background=true 的子代理帧由 WebGate 直连 WebSocket 推送，可能落在本轮 done
   之后的空闲窗口。此时走通用分支会伪造一轮永无 done 收尾的流（20s 后看门狗强制
   finishStream + 弹「强制结束」toast），用户会误以为后台任务出错。 */
function handleIdleAgentChunk(chunk, sid) {
    var sess = sessionMap[sid];
    // 会话尚未创建：交回通用分支按既有逻辑建会话。此时不存在「已被 finishStream 清空」
    // 的 currentBubbleEl 空指针问题，而通用分支的 resetStreamState + showThinking 反而是必要的。
    if (!sess) return false;
    if (sess._replaying || sess.isStreaming) return false;

    /* 非当前会话：直接丢弃，绝不渲染。
       这不是「少显示一点」，而是防历史消息丢失：evictInactiveSessions 只清空非活跃会话的容器，
       而重新进入时的重建判据是 container.children.length === 0（见 app-base.js 的 LRU 注释）。
       往非活跃会话容器里新建气泡会让 children.length !== 0 → selectSession 不再触发
       loadMessages → 用户切过去只看到一张孤儿卡，整个历史消息消失。
       帧已落盘（emitToClient 旁路），用户切回该会话时由回放完整重建，故丢弃无损失。 */
    if (sid !== activeSessionId) return true;

    // 两张表必须存在（与 clearAgentState 的「两表口径一致」约束同源）：漏建任一张都会让
    // resolveAgentState 直接失败，agent_end 因 agentCards 无登记而进不了收卡分支，
    // 改去新建第二张卡，原卡的 .agent-status-icon.loading 就永远闪。
    if (!sess.agentCards) sess.agentCards = {};
    if (!sess.agentStates) sess.agentStates = {};

    // 空闲态渲染：不进流式态、不置停止按钮、不弹思考气泡，只把卡片挂进消息流。
    // currentBubbleEl 的空指针由 insertBeforeActions 内部兜底重建。
    try {
        onWebChunk(sess, chunk);
        // 进度心跳频率高（每个工具调用一次），不逐次滚底，避免用户正在往上翻阅时被抢滚动条
        if (chunk.type !== 'agent_progress') scrollToBottom(true);
    } catch (e) {
        reportStreamPipelineError('handleIdleAgentChunk', e, chunk);
    }
    return true;
}

function dispatchGateChunk(chunk) {
    var sid = chunk.sessionId;

    // WebSocket 流结束信号
    if (chunk.type === 'done') {
        if (!sid) return;
        var sess = sessionMap[sid];
        if (!sess) {
            /* 会话已被删除/淘汰：done 无处收尾。若它恰是活动会话且全局按钮卡在停止态，
             * 补一次最小复位——此时已无会话态可依，直接回发送态（幂等、零副作用）。 */
            if (sid === activeSessionId && isStreaming) {
                console.warn('[WebGate] done for missing session, resetting stuck stop-mode button');
                isStreaming = false;
                setBtnSendMode();
            }
            return;
        }
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
        /* 插话幂等集合只服务实时竞态（WS 的 steer_applied 早于 HTTP 200 到达），轮结束即过期。
           不清会在会话被 LRU 淘汰重建（evictInactiveSessions 清空容器）后继续拦住回放：
           旧 steerResolved 键仍在，重新进入会话时回放还原出的同一 steerId 会被当成已处理
           而静默丢弃，表现为「插话气泡刷新后消失」。 */
        sess.steerResolved = {};
        sess._suppressQueueDispatch = resumeInProgress;
        // 【C1-c】挂起（等待作答/审批）而发的 done 不是真结束：保留批次与卡片索引，
        // 否则恢复后同一批工具会在新容器里重建，被拆成两组渲染。
        finishStream(sess, { keepBatchIndex: isSuspendedDone(sess, chunk) });
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

    /* 后台子代理（task/multitask 的 background=true）的可视化帧由 WebGate 直连 WebSocket 推送，
       可能落在本轮 done 之后的<b>空闲窗口</b>（后台任务的生命周期恰恰跨越主 run 边界）。
       空闲态下绝不能走下方通用分支，否则会踩两个实测确定的坑：
       ① 伪造流：通用分支无条件置 isStreaming=true + 停止按钮 + showThinking，而后台帧没有
          配对的 done 收尾 → 20s 后看门狗查到服务端 running=false → 强制 finishStream 并弹
          「强制结束」toast，用户会以为后台任务出错了。
       ② 空指针：通用分支的 resetStreamState 会把 sess.currentBubbleEl 置 null，而
          appendAgentBadge → insertBeforeActions 裸解引用 currentBubbleEl.parentNode → 抛
          TypeError 被 onWebChunk 的 try/catch 静默吞掉，<b>卡片根本建不出来</b>。
       返回 true 表示已就地消费；返回 false 表示应交回原路径（流式中/回放中，原路径一切正常）。 */
    if (chunk.type === 'agent_start' || chunk.type === 'agent_end' || chunk.type === 'agent_progress') {
        if (handleIdleAgentChunk(chunk, sid)) return;
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
            // 后端已按 originSteerId 原子、幂等入 queue.json；前端失效缓存并强制刷新 UI（绕过缓存，
            // 否则同会话后续 getQueue 命中旧快照，chip 计数不动直到下一次 add/shift）。
            if (window.messageQueue && window.messageQueue.caches) delete window.messageQueue.caches[sid];
            if (sid === activeSessionId && typeof updateMessageQueueUI === 'function') updateMessageQueueUI({ force: true });
            if (!steerSess._replaying && typeof showToast === 'function') showToast(GourdI18n.t('streaming.steer_dropped'), 'info');
        }
        return;
    }

    // 即使 sess2 不存在，也优先处理 todowrite 动作（用于更新左侧 Sidebar 的 todo 进度）
    if (chunk.type === 'action_end' && chunk.toolName === 'todowrite') {
        if (window._todoChunkHandlers) {
            /* 外部注册的处理器必须逐个隔离：这里位于会话初始化之前且原为裸调用，
               任一处理器抛异常都会把整个 dispatchGateChunk 打断，该帧后续的渲染全部停摆。
               而 todowrite 后端只发 action_end（无配对 action_start），该分支每次都会跑到。 */
            window._todoChunkHandlers.forEach(function(h) {
                try { h(chunk); } catch (e) { reportStreamPipelineError('todoChunkHandler', e, chunk); }
            });
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
        ensureSidebarRefreshTimer();
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

/* 心跳（池化后一个定时器巡检所有桶）。
   为何不每桶一个定时器：N 条连接就是 N 个 15s 定时器，页面隐藏/唤醒时的
   漂移与开销都成倍；单定时器里逐桶发 ping 同样能完成僵尸检测。 */
function startWebGateHeartbeat() {
    stopWebGateHeartbeat();
    webGateHeartbeatTimer = setInterval(function() {
        gateSockets.forEach(function(entry, scopeKey) {
        if (entry && entry.socket && entry.socket.readyState === WebSocket.OPEN) {
            try { entry.socket.send('ping'); } catch (e) { /* 发送失败交由下方僵尸计数判定 */ }
            /* 【僵尸连接检测】ping 只发不校验的旧实现挡不住「半开 TCP」：
               后端进程重启/Tauri 代理透传任务死亡/系统休眠唤醒等场景下，浏览器侧
               readyState 恒为 OPEN、onclose/onerror 永不触发，后端所有流式帧静默
               丢失——界面表现为「发送消息后长时间不动，切换会话再切回才能看到内容」
               （切回走 HTTP replay 重建，HTTP 每次新建连接不受影响）。
               对策：每个周期未收到 pong 则计数，连续 3 个周期（约 45s）未响应即判定
               僵尸，主动 close 触发既有 onclose 恢复链路（重连 + 按 eventSeq 游标
               replay 补流，正在流式的会话无感自愈）。收到 pong 时清零。

               【池化后的关键】计数必须按桶存：共用一个全局计数时，A 桶回了 pong
               会把 B 桶的僵尸证据清零，B 桶的半开连接就永远检测不到。local 桶额外
               镜像到全局 webGatePongMisses（诊断出口与既有僵尸检测契约读的是它）。 */
            if (scopeKey === 'local') {
            webGatePongMisses = (webGatePongMisses || 0) + 1;
            if (webGatePongMisses >= 3) {
                console.warn('[WebGate] no pong for ' + (webGatePongMisses * 15) + 's, treating as dead connection, forcing reconnect');
                var dead = entry.socket;
                webGatePongMisses = 0;
                try { dead.close(); } catch (e) {}
                /* close() 不保证同步触发 onclose（半开连接可能连 FIN 都发不出去），
                   兜底：摘回调后立即主动走一次重连（与 onclose 同构，幂等安全）。
                   不直接 close 旧引用的回调，让 onclose 自然执行 markStreamingSessionsForRecovery。 */
                scheduleWebGateReconnect(scopeKey);
            }
            return;
            }
            entry.pongMisses = (entry.pongMisses || 0) + 1;
            if (entry.pongMisses >= 3) {
                console.warn('[WebGate:' + scopeKey + '] no pong for ' + (entry.pongMisses * 15) + 's, treating as dead connection, forcing reconnect');
                var deadR = entry.socket;
                entry.pongMisses = 0;
                try { deadR.close(); } catch (e) {}
                scheduleWebGateReconnect(scopeKey);
            }
        }
        });
    }, 15000);
}

function stopWebGateHeartbeat() {
    if (webGateHeartbeatTimer) {
        clearInterval(webGateHeartbeatTimer);
        webGateHeartbeatTimer = null;
    }
    webGatePongMisses = 0;
}

/* 池里再没有任何 OPEN/CONNECTING 连接时才停心跳定时器。
   旧实现在单一 socket 的 onclose 里无条件停——池化后一条远端桶断开
   会把本地桶的心跳一并停掉，本地僵尸连接从此检测不到（新形态回归）。 */
function stopWebGateHeartbeatIfIdle() {
    var anyLive = false;
    gateSockets.forEach(function(e) {
        if (e && e.socket && (e.socket.readyState === WebSocket.OPEN || e.socket.readyState === WebSocket.CONNECTING)) {
            anyLive = true;
        }
    });
    if (!anyLive) stopWebGateHeartbeat();
}

/* scopeKey（可选）：只给该桶排退避重连；不传 = 全池口径（回收巡检用）。

   为什么必须按桶分账：共用一个全局 attempts 时，一条远端隧道断开会把退避计数拉高，
   本地那条的重连间隔跟着指数膨胀——用户看到的是「本地也不动了」。 */
function scheduleWebGateReconnect(scopeKey) {
    if (!scopeKey) {
        /* 全池口径：只遍历【已在池中】的桶。被回收的桶已摘池，绝不能在此重建
           （否则空闲回收与 LRU 永远关不掉连接，回收形同虚设）。 */
        gateSockets.forEach(function(e, k) { scheduleBucketReconnect(k); });
        return;
    }
    scheduleBucketReconnect(scopeKey);
}

function scheduleBucketReconnect(scopeKey) {
    if (gateSocketAlive(scopeKey)) return;                 // 活连接无需重连
    var entry = ensureGateEntry(scopeKey);
    if (entry.reconnectTimer) return;                      // 已在退避中（幂等）
    /* 远端桶：连接已从注册表消失（用户断开/探活掉线）则不再重连——重建由
       下一次发送（ensureWebGateConnected）或重新连接后的 connectWebGate 触发；
       无注册表（浏览器直开）时 gateScopeAlive 恒 true，行为退回无条件重连。 */
    if (scopeKey !== 'local' && !gateScopeAlive(scopeKey)) return;
    if (entry.reconnectAttempts >= WEBGATE_MAX_RECONNECT) {
        console.warn('[WebGate:' + scopeKey + '] reconnect attempts continuing at capped interval');
        entry.reconnectAttempts = WEBGATE_MAX_RECONNECT - 1;
    }
    var delay = Math.min(1000 * Math.pow(2, entry.reconnectAttempts), 30000);
    entry.reconnectAttempts++;
    if (scopeKey === 'local') webGateReconnectAttempts = entry.reconnectAttempts;   // 全局镜像（诊断）
    console.log('[WebGate:' + scopeKey + '] reconnecting in ' + delay + 'ms (attempt ' + entry.reconnectAttempts + ')');
    // 静默后台重连，不弹横幅
    entry.reconnectTimer = setTimeout(function() {
        entry.reconnectTimer = null;
        /* 桶可能已在退避期间被回收（空闲/LRU/连接死亡）：不重建，
           下一次发送或切回该工作区时 connectWebGate 会自建。 */
        if (gateSockets.get(scopeKey) !== entry) return;
        connectWebGate(scopeKey);
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
/* 注：connectWebGate 无参调用 → scopeKey 由 currentGateScopeKey() 推导。无多连接注册表
   （浏览器直开/无壳环境）时它恒为 'local'，即改造前的单连接行为（降级路径）。 */
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
        // 切换会话时补齐该会话的每轮变更卡片（帧早于容器创建到达的卡片在此补渲染；幂等）
        if (window.renderSessionFileChangeCards) window.renderSessionFileChangeCards(todoSess);
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
