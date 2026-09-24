/* ===== app-message.js ===== */
/* 消息渲染：消息气泡 + 思考动画 + 命令输出 + HITL + 回退 */
/* 依赖：app-base.js */

/* 复制图标（icon-only，用户与 AI 消息共用） */
var COPY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
var OK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
/* 重新运行（循环箭头）与继续运行（快进）图标 */
var RERUN_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';
var CONTINUE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>';

/* trace 耗时小图标（线条风格：时钟）。
   token 用量图标（输入/缓存/输出）已移除：用量只在输入框上方的上下文指示条展示一处，
   避免两处不同统计口径（本轮累计 vs 本次推理）并列造成歧义，详见 appendTraceBadge。 */
var TRACE_TIME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';

/* 思考块图标：单主体「灵感星芒」，用简洁几何表达正在形成的想法。
   与工具/智能体图标统一为 16 网格、1.2px 线宽；不使用灯泡或双半球大脑造型。 */
var THINKING_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 8.9 6.1 13 7l-4.1.9L8 12 7.1 7.9 3 7l4.1-.9Z"/><path d="m12.2 10.3.3 1.2 1.2.3-1.2.3-.3 1.2-.3-1.2-1.2-.3 1.2-.3Z"/></svg>';

/* 智能体卡片图标：机器人头线框（替代 emoji，保持线框风格统一）。 */
var AGENT_SVG = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 4.2V2.7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="1.9" r=".8" fill="currentColor" stroke="none"/><rect x="2.6" y="4.2" width="10.8" height="8.2" rx="2.4" stroke="currentColor" stroke-width="1.2"/><circle cx="5.9" cy="8.3" r=".9" fill="currentColor" stroke="none"/><circle cx="10.1" cy="8.3" r=".9" fill="currentColor" stroke="none"/><path d="M6.5 10.6h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

/* ===== Message Rendering (Session-Aware) ===== */
/* attachCounts：{images, files} 数量徽标。队列出队与插话降级重发手里只有会话内相对路径，
   本地没有 File/dataUrl，渲染不出缩略图；显示数量即可让用户确认附件确实带上了。 */
function appendUserMessage(sess, text, imageDataUrls, fileAttachments, createdAt, attachCounts) {
    var row = $('<div>').addClass('msg-row user')[0];
    row.setAttribute('data-user-msg-idx', sess.userMsgCounter++);
    row.innerHTML = '<div class="user-msg-col"><div class="msg-bubble"></div><div class="user-msg-footer"><span class="msg-time user-msg-time"></span><button class="user-copy-btn" title="' + GourdI18n.t('chat.copy') + '">' + COPY_SVG + '</button></div></div>';
    var bubble = $(row).find('.msg-bubble')[0];

    // Multiple images
    if (imageDataUrls && imageDataUrls.length > 0) {
        var imgWrap = $('<div>').addClass('user-attach-imgs')[0];
        for (var i = 0; i < imageDataUrls.length; i++) {
            var img = $('<img>').attr('src', imageDataUrls[i].dataUrl || imageDataUrls[i])
                .attr('style', 'max-height:120px;max-width:200px;border-radius:8px;object-fit:cover;')[0];
            $(imgWrap).append(img);
        }
        $(bubble).append(imgWrap);
    }

    // Multiple file attachments
    if (fileAttachments && fileAttachments.length > 0) {
        for (var j = 0; j < fileAttachments.length; j++) {
            var tag = $('<div>').addClass('user-attach-file')[0];
            tag.innerHTML = '<span class="user-attach-file-icon">' + fileIconSvg(14) + '</span>'
                + '<span class="user-attach-file-name">' + escapeHtml(fileAttachments[j].name) + '</span>'
                + '<span class="user-attach-file-size">(' + formatFileSize(fileAttachments[j].size) + ')</span>';
            $(bubble).append(tag);
        }
    }

    // 已落盘附件的数量徽标（队列出队等只有相对路径的场景）
    if (attachCounts && (attachCounts.images || attachCounts.files)) {
        var countsWrap = $('<div>').addClass('user-attach-counts')[0];
        if (attachCounts.images) {
            countsWrap.appendChild($('<span>').addClass('user-attach-badge')
                .text(GourdI18n.t('queue.images', { n: attachCounts.images }))[0]);
        }
        if (attachCounts.files) {
            countsWrap.appendChild($('<span>').addClass('user-attach-badge')
                .text(GourdI18n.t('queue.files', { n: attachCounts.files }))[0]);
        }
        $(bubble).append(countsWrap);
    }

    var span = $('<span>').addClass('user-msg-text md-content')[0];
    span.setAttribute('data-md-raw', text);
    span.innerHTML = renderMd(text);
    $(bubble).append(span);
    if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(span);
    if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(span);
    if (typeof processMermaidBlocks === 'function') processMermaidBlocks(span);

    // 长消息或含代码块时放宽气泡宽度，避免被挤成窄高条
    var hasCodeBlock = $(span).find('pre').length > 0;
    var isLongUserText = text && text.length > 100;
    if (hasCodeBlock || isLongUserText) $(row).addClass('wide-user');

    var copyBtn = $(row).find('.user-copy-btn')[0];
    $(copyBtn).on('click', function() {
        var txtEl = $(bubble).find('.user-msg-text')[0];
        var md = txtEl ? (txtEl.getAttribute('data-md-raw') || txtEl.innerText) : '';
        if (navigator.clipboard) {
            navigator.clipboard.writeText(md).then(function() {
                $(copyBtn).addClass('copied');
                copyBtn.innerHTML = OK_SVG;
                setTimeout(function() {
                    $(copyBtn).removeClass('copied');
                    copyBtn.innerHTML = COPY_SVG;
                }, 1500);
            });
        }
    });

    // 时间戳（实时发送不传 createdAt 时兜底为当前时间，与历史加载行为一致）
    var msgTime = createdAt || Date.now();
    var timeEl = $(row).find('.user-msg-time')[0];
    if (timeEl) $(timeEl).text(formatMsgTime(msgTime));

    addImageLightbox(bubble);
    $(renderRoot(sess)).append(row);
    /* 渲染落点是游离的临时容器时（回放进行中）跳过滚动：节点还没进文档，滚动既无意义
       又会把用户从正在看的位置拽走。旧实现靠「sess.container 当时被换成了临时容器、
       因而不在文档中」这一副作用间接达到同样效果；容器语义恒定后该副作用不复存在，
       必须改为显式判定落点。*/
    if (sess.sessionId === activeSessionId && !isDetachedRenderTarget(sess)
            && document.contains(sess.container)) scrollToBottom(true);
}

function appendSystemNotice(sess, text) {
    var row = $('<div>').addClass('msg-row system-notice')[0];
    row.innerHTML = '<div class="system-notice-bubble">' + escapeHtml(text) + '</div>';
    $(renderRoot(sess)).append(row);
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}

/* 插话长文本折叠：超过约 6 行或 320 字时默认收起为 5 行（CSS 限高 + 末段渐隐），
   卡片底部出现「展开全文（共 N 字）」按钮，点击展开、再点「收起」还原；短文本保持原样。
   判定为「阈值初判 + 实际高度校正」双口径：字符数超限但视觉不足 5 行时（如超长单行
   token），校正后不折叠，避免出现点了没变化的无效按钮；容器隐藏的会话回放测不到
   高度，保持阈值判定。CSS 的 max-height 按 5 行（5 × 20.8px）与之对齐。 */
var STEER_COLLAPSE_MAX_CHARS = 320;
var STEER_COLLAPSE_MAX_LINES = 6;
var STEER_COLLAPSE_VISIBLE_LINES = 5;

function steerNoteShouldCollapse(text) {
    var t = (text == null) ? '' : String(text);
    if (t.length > STEER_COLLAPSE_MAX_CHARS) return true;
    return t.split('\n').length > STEER_COLLAPSE_MAX_LINES;
}

function appendSteerNote(sess, item) {
    if (!sess || !item || !item.steerId) return;
    if ($(renderRoot(sess)).find('[data-steer-id="' + item.steerId + '"]').length) return;

    finishThinkingBlock(sess);
    ensureAssistantBubble(sess);

    var text = (item.text == null) ? '' : String(item.text);
    var note = $('<div>').addClass('steer-note')[0];
    note.setAttribute('data-steer-id', item.steerId);
    if (item.runId || sess.activeRunId) note.setAttribute('data-run-id', item.runId || sess.activeRunId);
    note.innerHTML = '<span class="steer-note-badge">' + escapeHtml(GourdI18n.t('streaming.steer_tag')) + '</span>'
        + '<span class="steer-note-text"></span>';
    $(note).find('.steer-note-text').text(text);

    // 插话携带的附件：后端只回传相对路径，本地没有 File，显示数量徽标（与队列出队气泡同口径）。
    // 历史回放走同一个 steer_applied 事件，因此刷新后徽标依然能还原。
    var steerImgs = (item.imagePaths || []).length;
    var steerFiles = (item.filePaths || []).length;
    if (steerImgs || steerFiles) {
        var attachWrap = $('<div>').addClass('steer-note-attachments')[0];
        if (steerImgs) {
            attachWrap.appendChild($('<span>').addClass('user-attach-badge')
                .text(GourdI18n.t('queue.images', { n: steerImgs }))[0]);
        }
        if (steerFiles) {
            attachWrap.appendChild($('<span>').addClass('user-attach-badge')
                .text(GourdI18n.t('queue.files', { n: steerFiles }))[0]);
        }
        note.appendChild(attachWrap);
    }

    insertBeforeActions(sess, note);

    if (steerNoteShouldCollapse(text)) {
        var steerTextEl = $(note).find('.steer-note-text')[0];
        var steerLineH = steerTextEl ? (parseFloat(window.getComputedStyle(steerTextEl).lineHeight) || 0) : 0;
        var steerFullH = steerTextEl ? steerTextEl.scrollHeight : 0;
        var visuallyShort = steerLineH > 0 && steerFullH > 0
            && steerFullH <= steerLineH * STEER_COLLAPSE_VISIBLE_LINES + 2;
        if (!visuallyShort) {
            $(note).addClass('collapsed');
            var steerToggle = $('<button>').addClass('steer-note-toggle').attr('type', 'button')[0];
            steerToggle.setAttribute('aria-expanded', 'false');
            steerToggle.textContent = GourdI18n.t('streaming.steer_expand_full', [text.length]);
            note.appendChild(steerToggle);
            $(steerToggle).on('click', function() {
                var collapsed = $(note).toggleClass('collapsed').hasClass('collapsed');
                steerToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                steerToggle.textContent = collapsed
                    ? GourdI18n.t('streaming.steer_expand_full', [text.length])
                    : GourdI18n.t('streaming.steer_collapse');
            });
        }
    }

    // 推进正文指针，让后续 AI 正文落在插话卡片之后；不清 toolCardsById/currentBatch。
    advanceBodyPointer(sess, sess, function(freshMd) { insertBeforeActions(sess, freshMd); });
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}
window.appendSteerNote = appendSteerNote;

function ensureAssistantBubble(sess) {
    if (!sess.currentBubbleEl) {
        removeThinking(sess);
        var row = $('<div>').addClass('msg-row assistant')[0];
        // 存储当前 runId，用于后续删除同一运行的消息
        if (sess.currentRunId) {
            row.setAttribute('data-run-id', sess.currentRunId);
        }
        row.innerHTML = '<div class="msg-bubble"><div class="md-content"></div>'
            + '<div class="msg-meta-row">'
            + '<div class="msg-time" style="display:none"></div>'
            + '</div>'
            + '<div class="msg-actions">'
            + '<button class="user-copy-btn copy-btn" title="' + GourdI18n.t('chat.copy') + '">' + COPY_SVG + '</button>'
            + '<button class="user-copy-btn rerun-btn" title="' + GourdI18n.t('chat.rerun') + '">' + RERUN_SVG + '</button>'
            + '<button class="user-copy-btn continue-btn" title="' + GourdI18n.t('chat.continue_run') + '">' + CONTINUE_SVG + '</button>'
            + '</div></div>';
        $(renderRoot(sess)).append(row);
        sess.currentBubbleEl = $(row).find('.md-content')[0];
        var copyBtn = $(row).find('.copy-btn')[0];
        // 复制目标为「最终答案」：统一从 .md-content 的 data-md-raw 读取。
        // 历史消息与流式结束后后端写入的最终答案都带该属性；流式接收过程中不写，故复制不到中间片段。
        // 无 data-md-raw 时（旧数据/异常）回退到尾部首个非空块的 innerText。
        var bubbleEl = $(row).find('.msg-bubble')[0];
        $(copyBtn).on('click', function() {
            var md = '';
            var blocks = $(bubbleEl).children('.md-content');
            for (var bi = blocks.length - 1; bi >= 0; bi--) {
                var raw = blocks[bi].getAttribute('data-md-raw');
                if (raw != null && raw.trim()) { md = raw; break; }
            }
            if (!md) {
                for (var bj = blocks.length - 1; bj >= 0; bj--) {
                    var t = blocks[bj].innerText || '';
                    if (t.trim()) { md = t; break; }
                }
            }
            if (navigator.clipboard) {
                navigator.clipboard.writeText(md).then(function() {
                    $(copyBtn).addClass('copied');
                    copyBtn.innerHTML = OK_SVG;
                    setTimeout(function() {
                        $(copyBtn).removeClass('copied');
                        copyBtn.innerHTML = COPY_SVG;
                    }, 1500);
                });
            }
        });
        // 重新运行 / 继续运行：复用后端已有的 /rerun、/continue 命令。
        // rerun：删除同一 runId 的所有 AI 消息行（旧回复），新回复流式渲染到新气泡，与后端回退保持一致。
        // continue：保留当前气泡，新内容自然追加到新气泡，呈现“接着往下写”的效果。
        var rerunBtn = $(row).find('.rerun-btn')[0];
        var continueBtn = $(row).find('.continue-btn')[0];
        function triggerCommand(cmd, removeRow) {
            if (sess.isStreaming) return;
            if (typeof sendCommandSilent !== 'function') return;
            sendCommandSilent(cmd, function() {
                if (removeRow) {
                    // 删除同一 runId 的所有元素（消息行、工具卡片、思考块等）
                    var runId = row.getAttribute('data-run-id');
                    if (runId) {
                        // 删除所有具有相同 runId 的元素
                        $(sess.container).find('[data-run-id="' + runId + '"]').remove();
                    } else {
                        // 兼容旧数据：如果没有 runId，只删除当前行
                        $(row).remove();
                    }
                    // 重置会话状态
                    sess.currentBubbleEl = null;
                    sess.thinkingBlockEl = null;
                    sess.pendingToolCard = null;
                }
            });
        }
        if (rerunBtn) $(rerunBtn).on('click', function() { triggerCommand('/rerun', true); });
        if (continueBtn) $(continueBtn).on('click', function() { triggerCommand('/continue', false); });
        // 流式输出过程中隐藏复制按钮，待 finishStream 收尾后再显示；
        // 非流式（历史加载）保持原有显示逻辑。
        if (sess.isStreaming) {
            $(row).find('.msg-actions').hide();
            // 流式中提前创建常驻的内联等待指示器（默认不可见但占位），避免后续显隐造成跳动。
            ensureInlineThinking(sess);
        }
    }
    return sess.currentBubbleEl;
}

/* ===== 共享流式渲染核心（主线路与智能体卡片共用） =====
   holder 抽象：主线路以 sess 自身为 holder（currentBubbleEl/thinkingBlockEl 等字段直接挂在 sess 上），
   智能体卡片以每个智能体独立的状态对象 st 为 holder（字段同名、按智能体隔离、并行互不串）。
   两条线路走同一套 ensure/finish/append/advance 函数，从结构、样式到时序完全一致。 */

/* 构建 thinking-block DOM（头部 + 体），主线路与智能体卡片共用，保证结构/样式一致 */
function createThinkingBlockEl(sess) {
    var block = $('<div>').addClass('thinking-block streaming')[0];
    // 存储当前 runId，用于后续删除同一运行的消息
    if (sess.currentRunId) {
        block.setAttribute('data-run-id', sess.currentRunId);
    }
    // 与工具卡片保持一致：简洁展示关闭时才默认展开
    if (window.cliPrintSimplified === false) $(block).addClass('expanded');
    block.innerHTML = '<div class="thinking-block-header">'
         + '<span class="tool-type-icon">' + THINKING_SVG + '</span>'
        + '<span class="thinking-block-label" data-i18n-thinking="progress">' + GourdI18n.t('chat.thinking_in_progress') + '</span>'
        + '<span class="thinking-timer-wrap" style="margin-left:4px">'
         + '<span class="thinking-current-timer">0s</span>'
         + '</span>'
         + '<span class="thinking-status-dot"></span>'
        + '</div>'
        + '<div class="thinking-block-body"><div class="md-content"></div></div>';
    $(block).find('.thinking-block-header').on('click', function() {
        $(block).toggleClass('expanded');
    });
    return block;
}

/* 卡体跟随底部：智能体卡体（.agent-card-body）是限高滚动容器，流式内容到达时需主动置底，
   否则新内容会隐在卡体视口下方（用户看不到正在输出什么）。用户在卡内主动向上翻看时停止跟随。

   停跟随的判据必须是【滚动方向】而非【距底部距离】，原因见下方 scroll 监听的注释。 */
function followAgentCardBody(bodyEl, st) {
    if (!bodyEl) return;
    if (st && st.bodyUserScrolledUp) return;
    bodyEl.scrollTop = bodyEl.scrollHeight;
}
/* holder 版跟随：主线路 holder（sess）无 bodyEl（正文直接落在消息区），对其为空操作。 */
function followHolderBody(h) {
    if (!h) return;
    followAgentCardBody(h.bodyEl, h);
}

/* 在 holder 上确保 thinking-block。正文指针推进逻辑（主线路与智能体一致）：
   当前正文容器已有内容（含缓冲中待渲染内容）时先收敛并新开正文容器，新思考块落在旧正文之后、
   后续正文落在思考块之后；无内容时思考块就当前位置、复用当前正文容器。
   opts.placeFresh(freshMd)：新正文容器落点；opts.placeBlock(block, pointerEl)：思考块落点
   （pointerEl 为当前正文容器，可能为 null）。 */
function ensureThinkingBlockCore(sess, h, opts) {
    if (h.thinkingBlockEl) return h.thinkingBlockEl;
    // 交错思考复用窗口：模型在同一 run 内交替产出思考与正文（interleaved thinking，
    // 真实会话实测单 run 21 次 reason/text 切换）时，每段正文都会收敛思考块并推进正文指针，
    // 下一段思考又新开块——UI 被撕成「N 个思考完成条 + N 段正文碎片」的交替矩阵（用户截图现象）。
    // 同 run、中间无工具派发、且距上次收敛未超阈值时复用刚收敛的块：恢复流式外观继续追加思考，
    // 正文指针不动，UI 收敛为「一个思考块 + 连续正文」。真轮边界（user/done/trace）与工具派发
    // 都会打破复用条件，多轮对话与工具夹心的版式不受影响。
    if (h._lastFinishedThinkingBlockEl && h._lastThinkingRunId
            && h._lastThinkingRunId === sess.currentRunId
            && !h._thinkingInterruptedByAction
            && (sess._replayClock || Date.now()) - (h._lastFinishedThinkingAt || 0) < 5000) {
        var reused = h._lastFinishedThinkingBlockEl;
        h._lastFinishedThinkingBlockEl = null;
        if (reused.parentNode) {
            h.thinkingBlockEl = reused;
            h.thinkingBodyWrapEl = $(reused).find('.thinking-block-body')[0];
            // 旧体的增量渲染器已在 finish() 里全量收敛并释放 buf：再 append 会清空已渲染内容
            // 重来（createStreamMd 的 !active 重置分支）。故新思考段落在同块体内的新 md-content：
            // 视觉上仍是一个思考块，上段内容保留在上、新段流式续在下。
            var reuseBody = $('<div>').addClass('md-content')[0];
            if (h.thinkingBodyWrapEl) h.thinkingBodyWrapEl.appendChild(reuseBody);
            h.thinkingBodyMdEl = reuseBody;
            h.thinkingBuffer = '';
            $(reused).addClass('streaming');
            var rlabel = $(reused).find('.thinking-block-label')[0];
            if (rlabel) {
                $(rlabel).text(GourdI18n.t('chat.thinking_in_progress'));
                rlabel.setAttribute('data-i18n-thinking', 'progress');
                rlabel.removeAttribute('data-i18n-elapsed');
            }
            var rheader = $(reused).find('.thinking-block-header')[0];
            if (rheader && !$(reused).find('.thinking-timer-wrap')[0]) {
                rheader.insertAdjacentHTML('beforeend',
                    '<span class="thinking-timer-wrap" style="margin-left:4px"><span class="thinking-current-timer">0s</span></span>');
            }
            startThinkingTimer(h, 'thinkingBlockTimerId', 'thinkingBlockStartTime', $(reused).find('.thinking-current-timer')[0]);
            return h.thinkingBlockEl;
        }
    }
    var cur = h.currentBubbleEl;
    // 「已有正文」不能只看 DOM：正文经 requestAnimationFrame 异步落盘，chunk 密集到达时
    // text 的内容可能仍缓存在 reasonBuffer 里、渲染帧尚未触发，此刻 md-content 还是空的。
    // 若此时仅凭 children/textContent 判空，会把思考块插到空气泡之前，随后待渲染的正文落进该气泡，
    // 造成「先到的正文反被顶到后到的思考块之下」（思考块错误置顶）。故把待渲染缓冲一并计入。
    var hasPendingText = !!(h.reasonBuffer && h.reasonBuffer.trim().length > 0);
    var hasContent = cur && ((cur.children && cur.children.length > 0) || (cur.textContent || '').trim().length > 0 || hasPendingText);
    if (hasContent) {
        // 先把增量渲染器挂起的尾部刷进旧气泡（finish 内部取消 rAF 并全量收敛），避免其稍后写入新（错误）气泡。
        // 判定条件用「渲染器仍处流式态」而非 hasPendingText：hasContent 也可能仅由 children/textContent
        // 成立（如 reasonBuffer 已被 advanceBodyPointer 清空），此时旧渲染器的 tail 区若仍挂着未提交尾部，
        // 不收尾就换容器会让它被永久遗弃在页面上（表现为与 stable 区并列的「重复正文」）。
        if (cur._streamMd && cur._streamMd.active) {
            cur._streamMd.finish();
            if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(cur);
            if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(cur);
        }
        h.reasonBuffer = '';
        var freshMd = $('<div>').addClass('md-content')[0];
        opts.placeFresh(freshMd);
        h.currentBubbleEl = freshMd;
        cur = freshMd;
    }
    var block = createThinkingBlockEl(sess);
    opts.placeBlock(block, cur);
    h.thinkingBlockEl = block;
    h.thinkingBodyMdEl = $(block).find('.thinking-block-body .md-content')[0];
    h.thinkingBodyWrapEl = $(block).find('.thinking-block-body')[0];
    // 监听思考区域滚动：判断用户是否主动向上翻看（写入 holder 自身，主线路与各智能体独立、互不污染）
    $(h.thinkingBodyWrapEl).on('scroll', function() {
        var gap = h.thinkingBodyWrapEl.scrollHeight - h.thinkingBodyWrapEl.scrollTop - h.thinkingBodyWrapEl.clientHeight;
        h.thinkingUserScrolledUp = gap > 60;
    });
    h.thinkingBuffer = '';
    var currentTimerSpan = $(block).find('.thinking-current-timer')[0];
    startThinkingTimer(h, 'thinkingBlockTimerId', 'thinkingBlockStartTime', currentTimerSpan);
    return h.thinkingBlockEl;
}

/* 收敛 holder 的 thinking-block（主线路与智能体卡片共用） */
function finishThinkingBlockCore(sess, h) {
    if (!h.thinkingBlockEl) return;
    stopThinkingTimer(h, 'thinkingBlockTimerId', 'thinkingBlockStartTime');
    if (h.thinkingBodyMdEl) {
        getStreamMd(h.thinkingBodyMdEl).finish();
    }
    if (h.thinkingBodyMdEl && typeof processMermaidBlocks === 'function') processMermaidBlocks(h.thinkingBodyMdEl);
    $(h.thinkingBlockEl).removeClass('streaming');
    var elapsed = '';
    if (h.thinkingBlockStartTime) {
        elapsed = ' (' + Math.floor((Date.now() - h.thinkingBlockStartTime) / 1000) + 's)';
    }
    var label = $(h.thinkingBlockEl).find('.thinking-block-label')[0];
    if (label) {
        $(label).text(GourdI18n.t('chat.thinking_finished') + elapsed);
        label.setAttribute('data-i18n-thinking', 'finished');
        label.setAttribute('data-i18n-elapsed', elapsed);
    }
    $(h.thinkingBlockEl).find('.thinking-block-dots').remove();
    $(h.thinkingBlockEl).find('.thinking-timer-wrap').remove();
    // 登记复用窗口（见 ensureThinkingBlockCore 头部注释）：同 run 的交错思考在短时间内
    // 再次到来时复用本块，而不是新开一个「思考完成」条把正文撕碎。
    h._lastFinishedThinkingBlockEl = h.thinkingBlockEl;
    h._lastFinishedThinkingAt = sess._replayClock || Date.now();
    h._lastThinkingRunId = sess.currentRunId || null;
    // 思考块收敛即代表「上次收敛之后没有工具夹心」的窗口重新开启
    h._thinkingInterruptedByAction = false;
    h.thinkingBlockEl = null;
    h.thinkingBodyMdEl = null;
    h.thinkingBodyWrapEl = null;
    h.thinkingBuffer = '';
}

/* 思考 chunk 增量渲染（holder 的思考块体），主线路与智能体卡片共用 */
function appendReasonChunkCore(sess, h, text) {
    var clean = clearThinkTags(text);
    h.thinkingBuffer += clean;
    var mdEl = h.thinkingBodyMdEl;
    if (!mdEl) return;
    // 增量渲染：stable 块只追加一次，tail 每帧重建（极小），消除逐帧全量 innerHTML 重建引起的闪烁
    var r = getStreamMd(mdEl);
    r.afterRender = function() {
        if (!h.thinkingBlockEl) return;
        if (h.thinkingBodyWrapEl) {
            // 仅当用户未主动向上滚动时才自动跟随底部
            if (!h.thinkingUserScrolledUp) {
                h.thinkingBodyWrapEl.scrollTop = h.thinkingBodyWrapEl.scrollHeight;
            }
        }
        // 智能体卡体自身也是滚动容器：内层思考块滚到底不代表它在卡体视口内，需同步跟随
        followHolderBody(h);
        // 统一走 scrollToBottom 协调器：内部复查用户上滚/回放 _skipScroll/锚定锁，
        // 直接同步赋值会绕开这些保护，把用户拉回底部（滚动抖动来源）
        if (sess.sessionId === activeSessionId && !sess._skipScroll) {
            scrollToBottom();
        }
    };
    r.append(clean);
}

/* 正文 chunk 增量渲染：reasonBuffer 同步记录待渲染文本（供思考块防置顶判定），
   afterRender 统一负责代码块按钮与滚动跟随。ensureEl 返回 holder 当前正文容器。 */
function appendBodyContentCore(sess, h, text, append, ensureEl) {
    var clean = clearThinkTags(text);
    h.reasonBuffer = append ? (h.reasonBuffer || '') + clean : clean;
    var el = ensureEl();
    // 增量渲染：stable 块只追加一次，tail 每帧重建（极小），消除逐帧全量 innerHTML 重建引起的闪烁
    var r = getStreamMd(el);
    r.afterRender = function() {
        // 流式接收过程中不写 data-md-raw（该属性是复制源，仅由 finishStream 后后端最终答案写入）；
        // 避免复制到被工具调用切开的中间片段。
        // 按钮仅添加一次（通过 data-hljs-collected 标记跳过已有按钮的 pre）
        if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(el);
        // 智能体卡体限高滚动，正文增量到达时跟随卡内底部（主线路无 bodyEl，空操作）
        followHolderBody(h);
        // 流式过程中不实时高亮，等 finishStream 时再一次性处理，避免高亮引起的布局跳动
        if (sess.sessionId === activeSessionId) {
            // 统一走 scrollToBottom 协调器（内部复查 userScrolledUp / _skipScroll / 锚定锁）：
            // 直接同步赋值虽快一帧，但绕开了回放与锚定保护，会把用户拉回底部造成抖动
            if (!sess._skipScroll) {
                scrollToBottom();
            }
        }
    };
    if (append) r.append(clean); else r.replace(clean);
}

/* 判定正文容器是否「视觉为空」：无文本且无块级内容。
   指针推进遗留的空 .md-content 会被 padding 撑高、夹在两张卡之间时阻止 margin 折叠，
   造成卡片间隔忽高忽低；仅空白文本 chunk 渲染出的空 <p> 残留同理，需清除。 */
function isVisuallyEmptyMd(el) {
    if (!el || !el.parentNode) return false;
    // 携带 data-md-raw 的容器是复制按钮的权威数据源（appendTraceBadge 写入的后端最终答案）。
    // 这类容器可能自身没渲染任何正文（正文被工具卡切走后指针新开的空容器），视觉上确实为空，
    // 但一旦被清扫掉，复制会静默回退到「尾部片段」甚至空串。故先于视觉判定短路保留。
    if (el.getAttribute && (el.getAttribute('data-md-raw') || '').trim()) return false;
    if ((el.textContent || '').trim()) return false;
    return !el.querySelector('img,pre,table,ul,ol,hr,blockquote,canvas,svg');
}

/* 清扫容器内视觉为空的正文容器（仅气泡/智能体卡体的直接子级，不动 thinking-block-body 内的 md）。
   智能体卡体与主气泡同构（thinking-block / tool-card / md-content），指针推进遗留的空 .md-content
   与空白 chunk 渲染出的空 <p> 残留同样会撑出参差间距，需一并清扫。 */
function purgeEmptyMdBlocks(container) {
    if (!container) return;
    $(container).find('.msg-bubble > .md-content, .agent-card-body > .md-content').each(function() {
        if (isVisuallyEmptyMd(this)) $(this).remove();
    });
}

/* 推进正文指针：工具卡/思考块产出后新开空 .md-content，让后续到达的正文写入卡片下方，
   而非停留在旧气泡里被卡片顶到上方。主线路与智能体卡片共用。 */
function advanceBodyPointer(sess, h, insertFresh) {
    if (!h) return;
    // 工具卡/插话是思考段的真实分界：派发后不得再复用上一个已收敛的思考块，
    // 否则「工具夹心」会被折叠进旧思考块，版式语义错乱（见 ensureThinkingBlockCore 复用窗口）。
    h._thinkingInterruptedByAction = true;
    // 换容器前必须收尾旧容器的流式渲染器：其 tail 区可能还挂着「未提交尾部」，而指针一推进，
    // 旧容器既不会再有帧驱动、也不会有人 finish 它（finishStream 只收尾当前容器），
    // 残留 tail 会与 stable 区并列固化成「重复正文」。finish() 内部取消挂起帧并全量收敛。
    var prev = h.currentBubbleEl;
    if (prev && prev._streamMd && prev._streamMd.active) {
        prev._streamMd.finish();
        // finish 会全量重建 innerHTML，复制按钮与高亮标记随之丢失，需补挂（与 ensureThinkingBlockCore 一致）
        if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(prev);
        if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(prev);
    }
    h.reasonBuffer = '';
    if (isVisuallyEmptyMd(h.currentBubbleEl)) $(h.currentBubbleEl).remove();
    var freshMd = $('<div>').addClass('md-content')[0];
    insertFresh(freshMd);
    h.currentBubbleEl = freshMd;
}

function ensureThinkingBlock(sess) {
    ensureAssistantBubble(sess);
    return ensureThinkingBlockCore(sess, sess, {
        placeFresh: function(el) { insertBeforeActions(sess, el); },
        placeBlock: function(block, pointerEl) { $(pointerEl).before(block); }
    });
}

function setAssistantTime(sess, ts) {
    var row = sess.currentBubbleEl ? $(sess.currentBubbleEl).closest('.msg-row')[0] : null;
    if (!row) return;
    var timeEl = $(row).find('.msg-time')[0];
    if (!timeEl) return;
    $(timeEl).text(formatMsgTime(ts || Date.now()));
    timeEl.style.display = '';
}

function insertBeforeActions(sess, el) {
    // 若存在常驻的内联等待指示器，新内容应插在其上方，保证指示器始终在气泡底部。
    var anchor = (sess.inlineThinkingEl && sess.inlineThinkingEl.parentNode) ? sess.inlineThinkingEl : null;
    if (anchor) { $(anchor).before(el); return; }
    // 否则插到「页脚」之上。页脚 = meta 行（时间/用量）+ 操作按钮，二者固定在气泡底部，
    // 正文一律累积在 meta 行之上。（曾有 bug：meta 行停在首个内容块之后，被后续流式内容顶到消息顶部。）
    var bubble = sess.currentBubbleEl.parentNode;
    var footer = $(bubble).find('.msg-meta-row').first()[0] || $(bubble).find('.msg-actions').first()[0];
    if (footer) $(footer).before(el);
    else $(bubble).append(el);
}

function finishThinkingBlock(sess) {
    finishThinkingBlockCore(sess, sess);
}

function clearThinkTags(text) {
    return text.replace(/<\s*\/?think\s*>/gi, '');
}

function appendReasonChunk(sess, text) {
    removeThinking(sess);
    ensureThinkingBlock(sess);
    appendReasonChunkCore(sess, sess, text);
}

function finishPendingTool(sess) {
    if (sess.pendingToolCard) {
        var icon = $(sess.pendingToolCard).find('.tool-status-icon')[0];
        if (icon) { icon.className = 'tool-status-icon done'; icon.innerHTML = ''; }

        sess.pendingToolCard = null;
    }
}

/* ===== Tool header meta helpers（类型图标 / 语言图标 / diff 统计 / 文件名回填） ===== */
/* 公共展示模型始终以裸工具名做 icon/i18n/renderer；nested 决定是否隐藏来源前缀。 */
function resolveToolPresentation(toolName, toolTitle, options) {
    options = options || {};
    var model = window.GourdToolPresentation.resolveToolPresentation(toolName, toolTitle, {
        nested: options.nested === true,
        internal: options.internal === true,
        agentName: options.agentName,
        translate: window.GourdI18n ? function(key) { return GourdI18n.t(key); } : null
    });
    return model;
}
window.resolveToolPresentation = resolveToolPresentation;

function toolTypeIcon(name) {
    return resolveToolPresentation(name, null).icon;
}

/* 兼容旧调用入口；新卡片路径应显式传 nested，避免只凭 title 猜测展示上下文。 */
function localizeToolName(toolName, toolTitle, options) {
    return resolveToolPresentation(toolName, toolTitle, options).displayName;
}
window.localizeToolName = localizeToolName;
/* 文件语言图标（emoji，按扩展名映射） */
function langIconEmoji(path) {
    var ext = (String(path).split('.').pop() || '').toLowerCase();
    var map = { java:'\u2615', js:'\ud83d\udfe8', mjs:'\ud83d\udfe8', ts:'\ud83d\udd37', jsx:'\u269b\ufe0f', tsx:'\u269b\ufe0f', py:'\ud83d\udc0d', css:'\ud83c\udfa8', scss:'\ud83c\udfa8', html:'\ud83c\udf10', json:'\ud83d\udd27', xml:'\ud83d\udcf0', md:'\ud83d\udcc4', sql:'\ud83d\uddc4\ufe0f', sh:'\ud83d\udc1a', go:'\ud83d\udc39', rs:'\ud83e\udd80', vue:'\ud83d\udc9a', yml:'\u2699\ufe0f', yaml:'\u2699\ufe0f' };
    return map[ext] || '\ud83d\udcc4';
}
/* 从 diff 文本统计增/删行数（排除 +++/--- 文件头） */
function computeDiffStat(args, text) {
    var diff = (args && typeof args.diff === 'string') ? args.diff : null;
    if (!diff && typeof text === 'string' && text.lastIndexOf('---', 0) === 0) diff = text;
    if (!diff) return null;
    var add = 0, del = 0;
    diff.split('\n').forEach(function(l) {
        if (l.charAt(0) === '+' && l.substr(0, 3) !== '+++') add++;
        else if (l.charAt(0) === '-' && l.substr(0, 3) !== '---') del++;
    });
    return { add: add, del: del };
}
/* 回填工具卡头部：文件名（带语言图标）+ diff 增删统计。幂等，可多次调用。 */
function updateToolHeaderMeta(cardEl, toolName, args, text) {
    var header = $(cardEl).find('.tool-card-header')[0];
    if (!header) return;
    var nameEl = $(header).find('.tool-name')[0];
    if (!nameEl) return;
    var fp = args && (args.file_path || args.path);
    if (fp) {
        var base = String(fp).split(/[\\/]/).pop();
        var fileEl = $(header).find('.tool-file')[0];
        if (!fileEl) {
            fileEl = document.createElement('span');
            fileEl.className = 'tool-file';
            nameEl.parentNode.insertBefore(fileEl, nameEl.nextSibling);
        }
        fileEl.innerHTML = '<span class="tool-file-lang">' + langIconEmoji(fp) + '</span>' + escapeHtml(base);
        fileEl.title = fp;
    }
    var stat = computeDiffStat(args, text);
    if (stat && (stat.add || stat.del)) {
        var anchor = $(header).find('.tool-file')[0] || nameEl;
        var statEl = $(header).find('.tool-diff-stat')[0];
        if (!statEl) {
            statEl = document.createElement('span');
            statEl.className = 'tool-diff-stat';
            anchor.parentNode.insertBefore(statEl, anchor.nextSibling);
        }
        statEl.innerHTML = (stat.add ? '<span class="add">+' + stat.add + '</span>' : '')
            + (stat.del ? '<span class="del">-' + stat.del + '</span>' : '');
    }
}
window.updateToolHeaderMeta = updateToolHeaderMeta;

/* 统一设置卡状态点：依据 chunk.text 是否以 __ERROR__ 开头判定。后端 WebStreamBuilder
   在工具真正出错（Exception）时仍然发 action_end，但文本前缀为 "__ERROR__"；
   正常执行结果不带此标记。失败则显示红点，成功显示绿点。 */
function setToolCardStatus(cardEl, text, failed) {
    var icon = $(cardEl).find('.tool-status-icon').first()[0];
    if (!icon) return;

    // 失败判定双通道：failed（后端 WebChunk.failed 显式标记，语义最可靠）优先，
    // __ERROR__ 文本前缀作为旧历史帧与其它通道的兼容约定。
    // 二者任一成立即判失败，保证没有 failed 字段的旧历史回放仍能正确显示红点。
    var isError = failed === true || (typeof text === 'string' && text.startsWith('__ERROR__'));

    setTimeout(function() {
        requestAnimationFrame(function() {
            if (icon) {
                // R6 修复：本回调有 300ms 延迟，与 finishStream 存在竞态。
                // finishStream 对缺帧批次会先把卡片收成 warn（缺帧标记），
                // 若本回调随后无条件覆写为 done，缺帧批次就会被误报成功。
                // 故仅当图标仍处于 loading（尚未被任何收尾逻辑处置）时才落态。
                if (icon.className.indexOf('loading') < 0) return;
                if (isError) {
                    icon.className = 'tool-status-icon reject';
                } else {
                    icon.className = 'tool-status-icon done';
                }
                icon.innerHTML = '';
            }
        });
    }, 300);
}


window.setToolCardStatus = setToolCardStatus;

/* 展示后端下发的工具真实耗时（WebChunk.durationMs，来源 ToolCallEndEvent.getDurationMs()）。
   旧实现从未下发该值，工具卡只能自增计时，无法反映实际执行时长。
   插入位置固定在状态点之前：DOM 顺序与 CSS order（duration=5 < 状态点=6）一致。
   不再使用 has-duration 布局覆盖调整排序——类切换会让「排序」在过渡窗口里异步变化，
   圆点先瞬移回内容之后、再跳回行尾（实测表现为「从左侧闪一下跑到右侧」）。 */
function setToolCardDuration(cardEl, durationMs, failed) {
    if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) return;
    if (!cardEl) return;
    var header = $(cardEl).find('.tool-card-header').first()[0];
    if (!header) return;
    if ($(header).find('.tool-duration').length) return; // 已有则不重复插入
    var label = durationMs >= 1000
        ? (Math.round(durationMs / 100) / 10) + 's'
        : Math.round(durationMs) + 'ms';
    var span = $('<span>').addClass('tool-duration' + (failed === true ? ' failed' : '')).text(label)[0];
    var statusEl = $(header).find('.tool-status-icon').first()[0];
    if (statusEl) $(statusEl).before(span);
    else $(header).append(span);
}
window.setToolCardDuration = setToolCardDuration;

/* 工具失败时把当前正在执行（loading）的卡片状态点置为红点。
   注：4.1 事件体系后，后端已不再吞掉失败的 ToolCallEndEvent（见 WebStreamBuilder#onToolFailure），
   失败会带 WebChunk.failed=true 下发，并由 appendActionEndChunk 就地把卡片收成红点；
   本函数保留作为 error 独立通道（整流异常）的兜底，把所有残留 loading 卡片一并置红，
   否则 finishStream 会将其强刷为绿点（误报成功）。 */
function markToolCardFailed(sess) {
    var icons = [];
    if (sess.pendingToolCard) {
        var pi = $(sess.pendingToolCard).find('.tool-status-icon').first()[0];
        if (pi) icons.push(pi);
    }
    // 并行批量 / id 模式下无 pendingToolCard，兑掉容器内所有残留 loading 的卡片。
    // 骨架卡（data-args-streaming：参数还在生成、工具压根没开始执行）必须排除在外：
    // 把它标红等于告诉用户「这个工具执行失败了」，而它从未被调用过。
    // 它的正确归宿是移除（removeOrphanArgsStreamingCards），不是留一张红色空卡。
    if (!icons.length && renderRoot(sess)) {
        $(renderRoot(sess)).find('.tool-card:not([data-args-streaming]) .tool-status-icon.loading, .tool-batch-header .tool-status-icon.loading')
            .each(function() { icons.push(this); });
    }
    icons.forEach(function(icon) { icon.className = 'tool-status-icon reject'; icon.innerHTML = ''; });
    removeOrphanArgsStreamingCards(sess);
    sess.pendingToolCard = null;
}
window.markToolCardFailed = markToolCardFailed;

/* ===== Tool Body Renderer Registry =====
   工具结果渲染注册表：按 toolName 注册专用渲染器，解耦硬编码的 if-else。
   renderer(bodyEl, text, args) 渲染成功返回 true；返回 falsy 则由调用方做纯文本兜底。
   新增工具的专用展示只需 window._toolRenderers[name] = fn，无需改动主流程。 */
window._toolRenderers = window._toolRenderers || {};

/* edit：git-diff 风格逐行着色 + 行号 */
window._toolRenderers.edit = function(bodyEl, text, args) {
    var diff = (args && typeof args.diff === 'string') ? args.diff : null;
    var result = (typeof text === 'string') ? text : null;
    if (!diff && result && result.startsWith('---')) { diff = result; result = null; }
    if (!diff && !result) return false;
    bodyEl.style.padding = '0';
    bodyEl.style.maxHeight = '400px';
    bodyEl.style.overflow = 'auto';
    bodyEl.style.fontFamily = 'var(--font-mono)';
    bodyEl.style.fontSize = '12px';
    bodyEl.style.lineHeight = '1.5';

    var lines = (diff || '').split('\n');
    var html = '';
    var oldLineNo = 0, newLineNo = 0;
    var hunkRe = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;

    for (var i = 0; diff && i < lines.length; i++) {
        var rawLine = lines[i];
        var line = escapeHtml(rawLine);

        if (rawLine.startsWith('+++') || rawLine.startsWith('---')) {
            html += '<div class="git-diff-line git-line-head">'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-text">' + line + '</span></div>';
        } else if (rawLine.startsWith('@@')) {
            var m = rawLine.match(hunkRe);
            if (m) {
                oldLineNo = parseInt(m[1], 10);
                newLineNo = parseInt(m[2], 10);
            }
            html += '<div class="git-diff-line git-line-hunk">'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-text">' + line + '</span></div>';
        } else if (rawLine.startsWith('+')) {
            html += '<div class="git-diff-line git-line-add">'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-num">' + (newLineNo++) + '</span>'
                + '<span class="git-line-text">' + line + '</span></div>';
        } else if (rawLine.startsWith('-')) {
            html += '<div class="git-diff-line git-line-del">'
                + '<span class="git-line-num">' + (oldLineNo++) + '</span>'
                + '<span class="git-line-num"></span>'
                + '<span class="git-line-text">' + line + '</span></div>';
        } else {
            html += '<div class="git-diff-line git-line-ctx">'
                + '<span class="git-line-num">' + (oldLineNo++) + '</span>'
                + '<span class="git-line-num">' + (newLineNo++) + '</span>'
                + '<span class="git-line-text">' + line + '</span></div>';
        }
    }
    // 输出段：成功时仅展示 diff（结果提示与改动重复，显示冗余，已隐藏）；
    // 仅在出错时渲染错误信息，避免编辑失败时卡片体空白。
    if (result && result !== diff) {
        // NOTE: "成功完成" 为后端工具执行成功返回的固定文案，此处判断是否包含该字样以区分正常结果与错误信息；如需改为常量应同步修改后端 WebStreamBuilder
        var isErr = result.indexOf("成功完成") < 0;
        if (isErr) {
            if (diff) html += '<div class="edit-result-sep"></div>';
            html += '<div class="edit-result is-error">'
                + '<span class="edit-result-label"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg> ' + GourdI18n.t('chat.edit_failed') + '</span>'
                + '<span class="edit-result-text">' + escapeHtml(result) + '</span></div>';
        }
    }
    bodyEl.innerHTML = html;
    return true;
};

/* write / read：按 file_path 推断语言，hljs 语法高亮 */
function renderHighlightedFile(bodyEl, text, args) {
    if (!text) return false;
    var filePath = (args && args.file_path) || '';
    var lang = (typeof window.guessLang === 'function') ? window.guessLang(filePath) : '';
    if (lang && typeof hljs !== 'undefined') {
        try {
            var highlighted = hljs.highlight(text, { language: lang, ignoreIllegals: true });
            bodyEl.innerHTML = '<pre style="margin:0;padding:10px;overflow:auto;border-radius:0;background:var(--bg-code, #f5f5f5);line-height:1.5"><code class="hljs">' + highlighted.value + '</code></pre>';
            return true;
        } catch(e) {
            return false;
        }
    }
    return false;
}
window._toolRenderers.write = renderHighlightedFile;
window._toolRenderers.read = renderHighlightedFile;

/* grep：按 '路径:行号: 内容' 逐行解析，同一文件归组，行号高亮、内容等宽。
   命中"未找到结果。"等非结果文本则交还兜底。 */
window._toolRenderers.grep = function(bodyEl, text, args) {
    if (!text) return false;
    var lineRe = /^(.*?):(\d+):\s?(.*)$/;
    var lines = text.split('\n');
    var groups = [];
    var index = {};
    var matched = 0;
    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        if (!raw) continue;
        var m = raw.match(lineRe);
        if (!m) {
            if (groups.length && (raw.indexOf('\u672a\u5b8c') >= 0 || raw.indexOf('\u8b66\u544a') >= 0 || raw.indexOf('\u622a\u65ad') >= 0)) {
                groups[groups.length - 1].note = (groups[groups.length - 1].note || '') + raw + ' ';
            }
            continue;
        }
        matched++;
        var p = m[1];
        if (!(p in index)) { index[p] = groups.length; groups.push({ path: p, hits: [] }); }
        groups[index[p]].hits.push({ ln: m[2], content: m[3] });
    }
    if (matched === 0) return false;
    var html = '<div class="grep-result">';
    var totalHits = 0;
    groups.forEach(function(g) { totalHits += g.hits.length; });
    html += '<div class="tool-summary">' + groups.length + ' ' + GourdI18n.t('chat.files') + ' / ' + totalHits + ' ' + GourdI18n.t('chat.matches') + '</div>';
    groups.forEach(function(g) {
        html += '<div class="grep-file"><span class="grep-file-icon"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1.5h4.75L12.5 5.75V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8.75 1.5v4.25H12.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg></span>' + escapeHtml(g.path) + '</div>';
        g.hits.forEach(function(h) {
            html += '<div class="grep-hit"><span class="grep-ln">' + escapeHtml(h.ln) + '</span>'
                + '<span class="grep-code">' + escapeHtml(h.content) + '</span></div>';
        });
        if (g.note) html += '<div class="grep-note">' + escapeHtml(g.note.trim()) + '</div>';
    });
    html += '</div>';
    bodyEl.innerHTML = html;
    return true;
};

/* glob / ls：按 '[FILE] path' / '[DIR] path/' 解析为带图标的文件列表；
   ls 递归 tree（缩进 + 树形字符）走兜底等宽展示，避免破坏对齐。 */
function renderFileListing(bodyEl, text, args) {
    if (!text) return false;
    if (text.indexOf('\u672a\u627e\u5230') >= 0 && text.indexOf('[') < 0) return false;
    var lines = text.split('\n');
    var entryRe = /^\[(FILE|DIR)\]\s+(.*)$/;
    var items = [];
    var hasTree = false;
    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        if (!raw) continue;
        var m = raw.match(entryRe);
        if (m) { items.push({ dir: m[1] === 'DIR', path: m[2] }); }
        else if (/[\u2502\u251c\u2514]/.test(raw)) { hasTree = true; break; }
    }
    if (hasTree || items.length === 0) return false;
    var html = '<div class="file-listing"><div class="tool-summary">' + items.length + ' ' + GourdI18n.t('chat.items') + '</div>';
    items.forEach(function(it) {
        var icon = it.dir
            ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 011-1h3.5l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1.5h4.75L12.5 5.75V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1V2.5a1 1 0 011-1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M8.75 1.5v4.25H12.5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>';
        html += '<div class="file-entry' + (it.dir ? ' is-dir' : '') + '">'
            + '<span class="file-entry-icon">' + icon + '</span>'
            + '<span class="file-entry-path">' + escapeHtml(it.path) + '</span></div>';
    });
    html += '</div>';
    bodyEl.innerHTML = html;
    return true;
}
window._toolRenderers.glob = renderFileListing;
window._toolRenderers.ls = renderFileListing;

/* bash：终端风格输出块，等宽、深色、保留换行 */
window._toolRenderers.bash = function(bodyEl, text, args) {
    bodyEl.style.padding = '0';
    var cmd = (args && args.command) ? args.command : '';
    var html = '<div class="bash-output">';
    if (cmd) html += '<div class="bash-cmd"><span class="bash-prompt">$</span> ' + escapeHtml(cmd) + '</div>';
    html += '<pre class="bash-stdout">' + escapeHtml(text || '(' + GourdI18n.t('chat.no_output') + ')') + '</pre>';
    html += '</div>';
    bodyEl.innerHTML = html;
    return true;
};

/* todowrite / todoread：内容为 markdown 任务清单，按 markdown 语法高亮展示原文（不做 HTML 渲染，保留 #、-、[ ] 等原始符号）。
   todowrite 优先取入参 todos（提交的清单原文），todoread 取返回值 text。 */
function renderTodoMarkdown(bodyEl, text, args) {
    var md = (args && typeof args.todos === 'string' && args.todos.trim()) ? args.todos : text;
    if (!md || typeof md !== 'string' || !md.trim()) return false;
    var inner;
    if (typeof hljs !== 'undefined') {
        try { inner = hljs.highlight(md, { language: 'markdown' }).value; } catch(e) {}
    }
    if (!inner) inner = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    bodyEl.innerHTML = '<pre style="margin:0;padding:10px"><code class="hljs language-markdown">' + inner + '</code></pre>';
    return true;
}
window._toolRenderers.todowrite = renderTodoMarkdown;
window._toolRenderers.todoread = renderTodoMarkdown;

/* 分发：命中专用 renderer 且渲染成功返回 true，否则交由调用方做纯文本兜底 */
function renderToolBody(bodyEl, toolName, text, args) {
    var renderer = window._toolRenderers[toolName];
    if (typeof renderer === 'function') {
        try {
            if (renderer(bodyEl, text, args)) return true;
        } catch(e) {}
    }
    return false;
}

/* 抽取：把 args 对象格式化为短字符串（供所有工具卡创建与更新路径复用）。 */
function formatToolArgsStr(args) {
    function formatArgValue(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'string') return v.replace(/\n/g, ' ');
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) return '[' + v.length + GourdI18n.t('chat.items') + ']';
        if (typeof v === 'object') {
            var keys = Object.keys(v);
            if (keys.length === 0) return '{}';
            if (keys.length > 3) return '{' + keys.slice(0, 2).join(',') + ',...}';
            var inner = [];
            keys.forEach(function(k) { inner.push(k + ':' + formatArgValue(v[k])); });
            var s = '{' + inner.join(',') + '}';
            return s.length > 30 ? '{' + keys.join(',') + '}' : s;
        }
        return String(v);
    }
    if (!args || typeof args !== 'object') return '';
    var parts = [];
    // 跳过大体积字段（由 body 渲染器专门展示），避免头部塞入整段 diff/内容
    var skip = { diff: 1, content: 1, todos: 1 };
    Object.keys(args).forEach(function(k) { if (skip[k]) return; parts.push(k + '=' + formatArgValue(args[k])); });
    var argsStr = parts.join(' ');
    if (argsStr.length > 80) argsStr = argsStr.substring(0, 77) + '...';
    return argsStr;
}

/* 工具卡公共展示更新：标题、图标、裸 toolName 数据契约一次完成。
   nested 由调用点的实际归属容器决定，不从带前缀 title 隐式推断。 */
function applyToolPresentation(cardEl, toolName, toolTitle, options) {
    if (!cardEl) return resolveToolPresentation(toolName, toolTitle, options);
    var presentation = resolveToolPresentation(toolName, toolTitle, options);
    var nameEl = $(cardEl).find('.tool-name').first()[0];
    var iconEl = $(cardEl).find('.tool-type-icon').first()[0];
    if (nameEl) {
        nameEl.textContent = presentation.displayName;
        window.GourdToolPresentation.ordinaryToolNameCleanupAttributes().forEach(function(attr) {
            nameEl.removeAttribute(attr);
        });
        tagToolName(nameEl, presentation);
    }
    if (iconEl) iconEl.innerHTML = presentation.icon;
    cardEl.setAttribute('data-tool-name', presentation.bareToolName);
    return presentation;
}

function toolPresentationOptions(agentBody, args, cardEl) {
    return {
        nested: !!agentBody || !!(cardEl && $(cardEl).closest('.agent-card').length),
        agentName: args && args.agentName
    };
}

/* 解析 chunk 归属的智能体输出状态：args.agentName 非空且该智能体卡片仍在活跃登记中时，
   返回其独立状态对象（每个智能体一份，支持并行多智能体互不串卡）；否则返回 null。
   注意：本函数与 resolveAgentCardBody 必须定义在顶层作用域——app-streaming.js 的 onWebChunk
   会直接调用它们；若嵌在某个函数体内（曾误嵌入 appendActionStartChunk），调用处抛 ReferenceError
   且被 onWebChunk 的 try/catch 静默吞掉，导致全部 reason/text/action 块无法渲染。
   归一化：agentDesc 为 null/undefined 时按空串处理，与 appendAgentBadge 的 agentId 构造保持一致，
   否则 description 缺省时会因 "name:null" ≠ "name:" 而归属失配、内容漏进主对话。 */
function resolveAgentState(sess, args) {
    var agentName = args && args.agentName;
    var agentDesc = (args && args.agentDesc != null) ? args.agentDesc : '';
    var invocationId = args && args.invocationId;
    var key = invocationId || (agentName ? agentName + ':' + agentDesc : '');
    if (key && sess.agentCards && sess.agentCards[key] && sess.agentStates) {
        return sess.agentStates[key] || null;
    }
    // 兼容旧历史帧：没有 invocationId 时继续按 name:desc 配对。
    var legacyKey = agentName ? agentName + ':' + agentDesc : '';
    if (invocationId && legacyKey && sess.agentCards && sess.agentCards[legacyKey] && sess.agentStates) {
        return sess.agentStates[legacyKey] || null;
    }
    return null;
}

/* 解析 chunk 归属的智能体卡片 .agent-card-body 容器（供工具卡等需要直接插入元素的场景）。
   与 resolveAgentState 的归属判定保持一致。 */
function resolveAgentCardBody(sess, args) {
    var st = resolveAgentState(sess, args);
    return st ? st.bodyEl : null;
}

/* 归一化批量元数据：允许 action_start/action_end 任一侧缺帧；字段不完整时保留 batchId/size，
   由插入逻辑按到达顺序分配槽位，避免批量卡片退化成互相套叠的普通卡片。 */
function normalizeBatchMeta(batchMeta) {
    if (!batchMeta || typeof batchMeta !== 'object') return null;
    var batchId = batchMeta.batchId == null ? '' : String(batchMeta.batchId).trim();
    var batchSize = Number(batchMeta.batchSize);
    if (!batchId || !isFinite(batchSize) || batchSize < 2 || Math.floor(batchSize) !== batchSize) return null;
    var batchIndex = Number(batchMeta.batchIndex);
    var hasIndex = isFinite(batchIndex) && Math.floor(batchIndex) === batchIndex
        && batchIndex >= 0 && batchIndex < batchSize;
    return { batchId: batchId, batchIndex: hasIndex ? batchIndex : null, batchSize: batchSize, degraded: !hasIndex };
}

/* 批次键：同 run 内按 batchId 唯一（runId 参与键名，防止跨轮复用的 batchId 串组）。 */
function batchKeyFor(sess, batchId) {
    return (sess.currentRunId || '') + '|' + batchId;
}

/* 定位或创建批次容器（首次创建时插入 DOM 并登记），返回 batch 结构。
action_start / action_end / action_batch 三条路径共用，保证分组口径唯一。 */
function ensureBatchGroup(sess, meta, insertAgentBody) {
    if (!sess.toolBatchesById) sess.toolBatchesById = {};
    var batchKey = batchKeyFor(sess, meta.batchId);
    var batch = sess.toolBatchesById[batchKey];
    if (batch && document.contains(batch.groupEl)) return batch;

    var group = $('<div>').addClass('tool-batch-group')[0];
    if (sess.currentRunId) group.setAttribute('data-run-id', sess.currentRunId);
    group.setAttribute('data-batch-id', meta.batchId);
    group.innerHTML = '<div class="tool-batch-header">'
        + '<span class="tool-type-icon"></span>'
        + '<span class="tool-batch-title"></span>'
        + '<span class="tool-batch-progress"></span>'
        + '<span class="tool-status-icon loading"></span>'
        + '</div>'
        + '<div class="batch-tool-items"></div>';
    $(group).find('.tool-batch-header').on('click', function() { $(group).toggleClass('expanded'); });
    if (window.cliPrintSimplified === false) $(group).addClass('expanded');
    if (insertAgentBody) {
        $(insertAgentBody).append(group);
        followAgentCardBody(insertAgentBody, findAgentStateByBody(sess, insertAgentBody));
    } else {
        insertBeforeActions(sess, group);
    }
    batch = { groupEl: group, batchSize: meta.batchSize, doneCount: 0,
        slots: new Array(meta.batchSize), agentBody: insertAgentBody || null };
    sess.toolBatchesById[batchKey] = batch;
    updateBatchGroupHeaderExplicit(batch);
    return batch;
}

/* 根据 action_start/action_end 共享的批量元数据建组并插入卡片。缺少 index 时按当前空槽顺序兜底。 */
function appendCardToBatch(sess, card, batchMeta, insertAgentBody) {
    var meta = normalizeBatchMeta(batchMeta);
    if (!meta) return false;
    var batch = ensureBatchGroup(sess, meta, insertAgentBody);
    var batchKey = batchKeyFor(sess, meta.batchId);
    var slot = meta.batchIndex;
    if (slot == null || batch.slots[slot]) {
        slot = -1;
        for (var i = 0; i < batch.slots.length; i++) {
            if (!batch.slots[i]) { slot = i; break; }
        }
        // 同一批次槽位已满时不覆盖已渲染卡片，退回普通卡片插入。
        if (slot < 0) return false;
    }
    batch.slots[slot] = card;
    card.setAttribute('data-batch-key', batchKey);
    card.setAttribute('data-batch-index', slot);
    if (meta.degraded) card.setAttribute('data-batch-degraded', '1');
    var itemsEl = $(batch.groupEl).find('.batch-tool-items')[0];
    var fragment = document.createDocumentFragment();
    for (var si = 0; si < batch.slots.length; si++) if (batch.slots[si]) fragment.appendChild(batch.slots[si]);
    itemsEl.appendChild(fragment);
    updateBatchGroupHeaderExplicit(batch);
    return true;
}

/* action_batch：后端在整批工具执行前一次性声明批次（batchId/batchSize/成员清单）。
   收到即把成员骨架卡「同一时刻」收编进容器——消除旧行为「第一张卡先出 → 容器后到 →
   逐张搬入」的中间态跳变。尚未建卡的成员保留空槽，由随后 action_start/action_end 帧
   照常填充；一个卡都没收编到时不预建空容器，退化为按第一张正式卡懒建组的旧行为。 */
function applyActionBatchChunk(sess, chunk, insertAgentBody) {
    if (!chunk) return;
    var meta = normalizeBatchMeta({ batchId: chunk.batchId, batchSize: chunk.batchSize });
    if (!meta) return;
    var members = (chunk.batchMembers && chunk.batchMembers.length) ? chunk.batchMembers : [];

    for (var i = 0; i < members.length; i++) {
        var m = members[i] || {};
        var actionId = (m.actionId == null) ? '' : String(m.actionId);
        if (!actionId) continue;
        var card = sess.toolCardsById && sess.toolCardsById[actionId];
        if (!card || !card.parentNode) continue;
        // 已归组的卡不再搬移（重复帧/乱序防御）：直接再调 appendCardToBatch 会把同一张卡挪进第二个空槽
        if (card.getAttribute('data-batch-key')) continue;
        var idx = Number(m.index);
        appendCardToBatch(sess, card, {
            batchId: meta.batchId,
            batchIndex: (isFinite(idx) && Math.floor(idx) === idx) ? idx : null,
            batchSize: meta.batchSize
        }, insertAgentBody);
    }
}
window.applyActionBatchChunk = applyActionBatchChunk;
window.normalizeBatchMeta = normalizeBatchMeta;

/* ===== 工具卡骨架（参数流式生成期） =====
   背景：模型生成大参数（如 write 一整篇 md）时，参数本身可以连续流 80+ 秒。
   旧行为里这段时间屏幕零反馈（底部还错误地显示「输出中」），随后工具卡突然以完成态冒出来。
   现由后端新增的 action_draft（刚确定函数名）/ action_args（参数进度）两种帧驱动：
   draft 立刻建骨架卡占位，args 持续更新头部进度，action_start 到达后原地转正。
   三者共享同一个 actionId，因此整个生命周期只有一张 DOM 卡片。 */

/* 工具卡 DOM 模板的唯一构建入口（骨架卡与正式卡共用）。
   为何必须抽取：两处各写一份 innerHTML，任何一方改了 header 结构，另一方就会漂移，
   「原地转正」时会找不到要回填的节点（表现为参数/文件名/耗时静默丢失）。
   argsStr 显式传入：骨架阶段后端不下发参数（此刻参数还不存在），必须传空串。
   状态点固定在 header 末尾：视觉排序依赖它自身的 order（见 app.css），DOM 序必须与之一致，
   否则布局重排的瞬间它会落回内容一侧（历史上表现为「从左侧闪一下跑到右侧」）。 */
function createToolCardShell(sess, toolName, args, toolTitle, actionId, agentBody, argsStr) {
    var argsHtml = argsStr ? '<span class="tool-args">' + escapeHtml(argsStr) + '</span>' : '';
    var card = $('<div>').addClass('tool-card')[0];
    if (sess.currentRunId) {
        card.setAttribute('data-run-id', sess.currentRunId);
    }
    if (actionId) card.setAttribute('data-action-id', actionId);
    if (window.cliPrintSimplified === false) $(card).addClass('expanded');
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-type-icon"></span>'
        + '<span class="tool-name"></span>'
        + argsHtml
        + '<span class="tool-status-icon loading"></span>'
        + '</div>'
        + '<div class="tool-card-body"></div>';
    applyToolPresentation(card, toolName, toolTitle, toolPresentationOptions(agentBody, args));
    updateToolHeaderMeta(card, toolName, args, null);

    $(card).find('.tool-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });
    return card;
}
window.createToolCardShell = createToolCardShell;

/* 参数字节数 → 人类可读体积。骨架卡头部唯一的动态信息，必须一眼看出「还在涨」。 */
function formatArgsBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (Math.round(n / 1024 * 10) / 10) + ' KB';
    return (Math.round(n / 1048576 * 10) / 10) + ' MB';
}
window.formatArgsBytes = formatArgsBytes;

/* action_draft：模型刚说出函数名、参数尚未开始/正在生成时立刻建骨架卡。
   幂等：同 actionId 已有卡片或已完成（completedActionIds）时直接返回，
   因为骨架帧与 action_start 用的是同一个原生 ToolCall.id，重复建卡会出现两张卡且其一永久 loading。 */
function appendActionDraftChunk(sess, toolName, toolTitle, actionId, args) {
    // 无 actionId 就无法与后续 action_start 幂等配对，宁可不建骨架（正式帧照常建卡）
    if (!actionId) return;
    if (sess.completedActionIds && sess.completedActionIds[actionId]) return;
    if (sess.toolCardsById && sess.toolCardsById[actionId]) return;

    ensureAssistantBubble(sess);
    // 子代理路由与 action_start 同机制：args.agentName 命中活跃智能体卡片时插进卡内
    var insertAgentBody = resolveAgentCardBody(sess, args);
    var presentation = resolveToolPresentation(toolName, toolTitle, toolPresentationOptions(insertAgentBody, args));
    var presentationTitle = toolTitle || (presentation.source ? presentation.source + '/' + presentation.bareToolName : null);
    var bareToolName = presentation.bareToolName;

    var card = createToolCardShell(sess, bareToolName, args, presentationTitle, actionId, insertAgentBody, '');
    // 骨架标记：供样式、孤儿清理、HITL 接管三处识别「尚未执行的卡」。
    // 状态点必须保持 loading 原样不动——setToolCardStatus 有 loading 守卫，
    // 一旦改了状态点 class，这张卡此后永远落不了态（永久闪烁）。
    $(card).addClass('args-streaming');
    card.setAttribute('data-args-streaming', '1');
    updateToolCardArgsProgress(sess, actionId, 0, card);

    if (!sess.toolCardsById) sess.toolCardsById = {};
    sess.toolCardsById[actionId] = card;

    // 骨架阶段没有批次元数据（后端此刻还不知道本轮并行几个调用），批量归组留到转正时处理
    if (insertAgentBody) {
        $(insertAgentBody).append(card);
        followAgentCardBody(insertAgentBody, findAgentStateByBody(sess, insertAgentBody));
    } else {
        insertBeforeActions(sess, card);
    }
    if (sess.sessionId === activeSessionId) scrollToBottom();
}
window.appendActionDraftChunk = appendActionDraftChunk;

/* action_args：按 actionId 更新骨架卡头部的「生成参数中 · N」。
   后端已做 200ms / 4096 字节双阈值节流，这里再用 requestAnimationFrame 合一次帧，
   保证同一帧内的多次进度只写一次文本，长参数期不会把主线程拖进反复重排。
   未命中卡片（帧早于建卡、卡已转正或已被移除）时静默返回，不得抛错打断 onWebChunk。 */
function updateToolCardArgsProgress(sess, actionId, argsBytes, cardEl) {
    var card = cardEl || ((actionId && sess && sess.toolCardsById) ? sess.toolCardsById[actionId] : null);
    if (!card || !card.getAttribute || !card.getAttribute('data-args-streaming')) return;
    var header = $(card).find('.tool-card-header').first()[0];
    if (!header) return;
    var bytes = Number(argsBytes);
    if (!isFinite(bytes) || bytes < 0) bytes = 0;
    var label = GourdI18n.t('chat.args_streaming', { size: formatArgsBytes(bytes) });
    var el = $(header).find('.tool-args-progress').first()[0];
    if (!el) {
        el = $('<span>').addClass('tool-args-progress')[0];
        var nameEl = $(header).find('.tool-name').first()[0];
        if (nameEl && nameEl.parentNode) nameEl.parentNode.insertBefore(el, nameEl.nextSibling);
        else header.appendChild(el);
        // 首帧同步落字：后台标签页的 rAF 会被冻结，异步写会让卡片只剩一个工具名
        el.setAttribute('data-args-bytes', String(bytes));
        el.textContent = label;
        return;
    }
    el.setAttribute('data-args-bytes', String(bytes));
    card._argsProgressText = label;
    if (card._argsProgressRaf) return;
    card._argsProgressRaf = requestAnimationFrame(function() {
        card._argsProgressRaf = 0;
        if (card._argsProgressText != null) el.textContent = card._argsProgressText;
    });
}
window.updateToolCardArgsProgress = updateToolCardArgsProgress;

/* 解除骨架态：摘标记、取消挂起的进度帧、移除进度文案。转正与 HITL 接管共用。 */
function clearArgsStreamingMark(card) {
    if (!card || !card.getAttribute) return;
    card.removeAttribute('data-args-streaming');
    $(card).removeClass('args-streaming');
    if (card._argsProgressRaf) { cancelAnimationFrame(card._argsProgressRaf); card._argsProgressRaf = 0; }
    card._argsProgressText = null;
    $(card).find('.tool-args-progress').remove();
}

/* 骨架卡转正：action_start 带完整参数到达时，把 draft 建的骨架卡原地改造成正式卡。
   状态点保持 loading 不动（语义正是「执行中」），落态仍交给 action_end。
   非骨架卡（真正重复的 action_start）返回 false，由调用方按原样忽略，不建第二张。 */
function adoptArgsStreamingCard(sess, card, toolName, args, presentationTitle, agentBody, batchMeta, argsStr) {
    if (!card || !card.getAttribute || !card.getAttribute('data-args-streaming')) return false;
    clearArgsStreamingMark(card);

    applyToolPresentation(card, toolName, presentationTitle, toolPresentationOptions(agentBody, args, card));
    updateToolHeaderMeta(card, toolName, args, null);
    if (argsStr == null) argsStr = formatToolArgsStr(args);
    if (argsStr) {
        var argsEl = $(card).find('.tool-args').first()[0];
        if (argsEl) argsEl.textContent = argsStr;
        else $('<span>').addClass('tool-args').text(argsStr).insertAfter($(card).find('.tool-name').first());
    }
    // 批次元数据只在正式帧下发，故转正时才可能需要把这张卡搬进批量容器
    if (!card.getAttribute('data-batch-key')) appendCardToBatch(sess, card, batchMeta, agentBody);
    if (sess.sessionId === activeSessionId) scrollToBottom();
    return true;
}

/* 取一张可被 HITL 审批卡接管的骨架卡（带 data-args-streaming）。
   优先按 actionId 精确命中：hitl 帧与 action_draft 的 actionId 同源于原生 ToolCall.getId()，
   故并发调用同名工具（如同时两个 bash、其中一个触发审批）也不会接管错卡片。
   actionId 缺失时（该字段新增前落盘的挂起任务、快照恢复而来）降级按工具名匹配，歧义时取最后一张。
   取出即解除登记与骨架标记，避免后续 action_start 再把它当骨架卡回填。 */
function takeoverArgsStreamingCard(sess, toolName, actionId) {
    if (!sess || !renderRoot(sess)) return null;
    var found = null;
    if (actionId && sess.toolCardsById) {
        var byId = sess.toolCardsById[actionId];
        // 必须仍带骨架标记：已收到 action_start 转正的卡不能被审批卡抢走
        if (byId && byId.getAttribute && byId.getAttribute('data-args-streaming') !== null) found = byId;
    }
    if (!found && toolName) {
        $(renderRoot(sess)).find('.tool-card[data-args-streaming]').each(function() {
            if (this.getAttribute('data-tool-name') === toolName) found = this;
        });
    }
    if (!found) return null;
    var foundId = found.getAttribute('data-action-id');
    if (foundId && sess.toolCardsById && sess.toolCardsById[foundId] === found) delete sess.toolCardsById[foundId];
    clearArgsStreamingMark(found);
    // 若该骨架卡已被 action_batch 批次声明帧提前收编进批量容器，接管时必须先摘出容器：
    // 容器默认折叠、折叠态子卡 display:none，审批按钮留在里面将不可见、无法操作。
    // 摘出时同步清槽位与批次标记，避免它继续参与该批次的完成计数。
    var group = $(found).closest('.tool-batch-group')[0];
    if (group) {
        var batchKey = found.getAttribute('data-batch-key');
        var batch = (batchKey && sess.toolBatchesById) ? sess.toolBatchesById[batchKey] : null;
        if (batch && batch.slots) {
            var idx = Number(found.getAttribute('data-batch-index'));
            if (isFinite(idx) && batch.slots[idx] === found) batch.slots[idx] = null;
        }
        found.removeAttribute('data-batch-key');
        found.removeAttribute('data-batch-index');
        found.removeAttribute('data-batch-degraded');
        $(group).before(found);
    }
    return found;
}

/* 移除孤儿骨架卡：只收到 action_draft、永远等不到 action_start 的卡片
   （用户点停止、模型吐参数途中出错、连接中断）。
   为何是移除而不是标黄：这张卡既无参数也无结果，留一个黄点空卡会被读成
   「这个工具执行失败了」，比什么都不显示更误导。由 finishStream / endTurn / 整流异常共用。 */
function removeOrphanArgsStreamingCards(sess) {
    if (!sess || !renderRoot(sess)) return 0;
    var removed = 0;
    $(renderRoot(sess)).find('.tool-card[data-args-streaming]').each(function() {
        var card = this;
        var actionId = card.getAttribute('data-action-id');
        if (actionId && sess.toolCardsById && sess.toolCardsById[actionId] === card) delete sess.toolCardsById[actionId];
        if (card._argsProgressRaf) { cancelAnimationFrame(card._argsProgressRaf); card._argsProgressRaf = 0; }
        $(card).remove();
        removed++;
    });
    return removed;
}
window.removeOrphanArgsStreamingCards = removeOrphanArgsStreamingCards;

/* action_start：工具调用前（来源引擎 ToolCallStartEvent）提前渲染 loading 卡片骨架。
   - 有 actionId（并发/并行场景）：卡片按 id 登记到 sess.toolCardsById，action_end 靠 id 精确配对，
     不再依赖到达顺序；后端下发 batchId/batchIndex/batchSize 时归入显式批量容器分组展示。
   - 无 actionId（旧数据/兼容）：退回原有 sess.pendingToolCard 位置配对逻辑，行为不变。 */
function appendActionStartChunk(sess, toolName, args, toolTitle, actionId, agentBody, batchMeta) {
    if (actionId && sess.completedActionIds && sess.completedActionIds[actionId]) return;
    batchMeta = normalizeBatchMeta(batchMeta);
    ensureAssistantBubble(sess);
    var insertAgentBody = agentBody || resolveAgentCardBody(sess, args);
    var presentation = resolveToolPresentation(toolName, toolTitle, toolPresentationOptions(insertAgentBody, args));
    var presentationTitle = toolTitle || (presentation.source ? presentation.source + '/' + presentation.bareToolName : null);
    toolName = presentation.bareToolName;

    var argsStr = formatToolArgsStr(args);
    var approvedState = window.GourdToolPresentation.resolveActionStartCardState(!!sess.approvedToolCard, actionId);

    // HITL 批准后的 action_start 必须接管原审批卡：有 actionId 时登记到 id 映射，
    // 无 actionId 时沿用 pending 配对；两种模式都立即消费 approvedToolCard，避免残留或重复建卡。
    if (approvedState.reuseApprovedCard) {
        var approvedCard = sess.approvedToolCard;
        sess.approvedToolCard = null;
        if (actionId) approvedCard.setAttribute('data-action-id', actionId);
        applyToolPresentation(approvedCard, toolName, presentationTitle, toolPresentationOptions(insertAgentBody, args, approvedCard));
        updateToolHeaderMeta(approvedCard, toolName, args, null);
        var approvedArgsEl = $(approvedCard).find('.tool-args').first()[0];
        if (argsStr) {
            if (approvedArgsEl) approvedArgsEl.textContent = argsStr;
            else $('<span>').addClass('tool-args').text(argsStr).insertAfter($(approvedCard).find('.tool-name').first());
        }
        var approvedBody = $(approvedCard).find('.tool-card-body').first()[0];
        if (approvedBody) { approvedBody.removeAttribute('style'); approvedBody.innerHTML = ''; }
        if (window.cliPrintSimplified === false) $(approvedCard).addClass('expanded');
        else $(approvedCard).removeClass('expanded');

        if (approvedState.registerByActionId) {
            if (!sess.toolCardsById) sess.toolCardsById = {};
            sess.toolCardsById[actionId] = approvedCard;
        } else {
            sess.pendingToolCard = approvedCard;
            sess.pendingToolStarted = true;
        }
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    // 同 actionId 已有卡片：绝不建第二张。骨架卡（action_draft 建）在此原地转正——
    // 摘骨架标记、清进度文案、用完整 args 回填头部；旧实现直接 return，骨架卡会永远
    // 停在「生成参数中」。非骨架卡（真正重复的 action_start）仍旧忽略。
    // 判定放在建卡之前，避免每个重复帧都空造一张丢弃的 DOM。
    if (actionId && sess.toolCardsById && sess.toolCardsById[actionId]) {
        adoptArgsStreamingCard(sess, sess.toolCardsById[actionId], toolName, args, presentationTitle,
            insertAgentBody, batchMeta, argsStr);
        return;
    }

    // 骨架卡与正式卡共用同一套 DOM 模板，避免两处结构漂移（见 createToolCardShell 注释）
    var card = createToolCardShell(sess, toolName, args, presentationTitle, actionId, insertAgentBody, argsStr);

    if (actionId) {
        // id 模式：登记卡片，供 action_end 精确回填；后端显式批次时归入批量容器
        // （HITL 审批结果回填态例外——让位给位置配对，复用审批卡，避免多卡）
        if (!sess.toolCardsById) sess.toolCardsById = {};
        sess.toolCardsById[actionId] = card;

        // 显式或降级批次：统一由共享插入器建组；缺少 batchIndex 时按到达顺序放入空槽。
        if (appendCardToBatch(sess, card, batchMeta, insertAgentBody)) {
            // 已归入批次，继续走统一滚动收尾。
        } else if (insertAgentBody) {
            $(insertAgentBody).append(card);
            followAgentCardBody(insertAgentBody, findAgentStateByBody(sess, insertAgentBody));
        } else {
            insertBeforeActions(sess, card);
        }
    } else {
        // 兼容路径：无 id，沿用位置配对
        finishPendingTool(sess);
        // 决定插入位置
        if (insertAgentBody) {
            $(insertAgentBody).append(card);
            followAgentCardBody(insertAgentBody, findAgentStateByBody(sess, insertAgentBody));
        } else {
            insertBeforeActions(sess, card);
        }
        sess.pendingToolCard = card;
        sess.pendingToolStarted = true;
    }

    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/* 批量分组标题文案：单一工具用该工具名，混合工具用通用「工具」。
   name/count 一并交给 chat.batch_tool_title 模板，避免手工拼接——各语言的词序与
   词间空格不同（如 en 需要 "Batch Read"、zh 需要「批量读取」），拼接会丢空格。 */
function batchTitleText(toolName, total) {
    var name = toolName ? localizeToolName(toolName, null) : GourdI18n.t('chat.tools');
    return GourdI18n.t('chat.batch_tool_title', { name: name, count: total });
}

/* 更新批量分组头部：类型图标 + 标题 + 进度。
   兼容旧 currentBatch 结构（有 toolName/count）和新显式批次结构（有 batchSize/slots）。 */
function updateBatchGroupHeader(batch) {
    if (!batch || !batch.groupEl) return;
    var iconEl = $(batch.groupEl).find('.tool-type-icon')[0];
    var titleEl = $(batch.groupEl).find('.tool-batch-title')[0];
    var progEl = $(batch.groupEl).find('.tool-batch-progress')[0];
    var total = batch.batchSize || batch.count || 0;
    var done = batch.doneCount || 0;
    if (progEl) progEl.textContent = done + '/' + total;
    if (iconEl) iconEl.innerHTML = toolTypeIcon(batch.toolName || null);
    if (titleEl) {
        titleEl.textContent = batchTitleText(batch.toolName || null, total);
        titleEl.setAttribute('data-i18n-batch-tool', batch.toolName || '');
        titleEl.setAttribute('data-i18n-batch-count', total);
    }
}

/* 显式批次头部更新（方案 B）：混合工具名用通用文案，图标用通用工具图标 */
function updateBatchGroupHeaderExplicit(batch) {
    if (!batch || !batch.groupEl) return;
    var iconEl = $(batch.groupEl).find('.tool-type-icon')[0];
    var titleEl = $(batch.groupEl).find('.tool-batch-title')[0];
    var progEl = $(batch.groupEl).find('.tool-batch-progress')[0];
    var total = batch.batchSize || 0;
    var done = batch.doneCount || 0;
    var presentCount = batch.slots ? batch.slots.filter(Boolean).length : 0;
    if (progEl) progEl.textContent = done + '/' + total;
    // 图标：若所有已到达卡片工具名相同则用该图标，否则用通用工具图标
    var names = batch.slots ? batch.slots.filter(Boolean).map(function(c) { return c.getAttribute && c.getAttribute('data-tool-name'); }) : [];
    var uniqueNames = names.filter(function(n, i, a) { return n && a.indexOf(n) === i; });
    var iconTool = uniqueNames.length === 1 ? uniqueNames[0] : null;
    if (iconEl) iconEl.innerHTML = toolTypeIcon(iconTool);
    if (titleEl) {
        titleEl.textContent = batchTitleText(iconTool, total);
        // 混合工具名写空串：relocalizeDynamicLabels 靠属性存在与否选中元素，
        // 不写属性会让批量标题在切换语言时整体漏译。
        titleEl.setAttribute('data-i18n-batch-tool', iconTool || '');
        titleEl.setAttribute('data-i18n-batch-count', total);
    }
}

/* 批量卡片完成计数：无论结果来自 action_start 配对还是 action_end 兜底，都只计一次。 */
function markBatchCardDone(sess, card) {
    if (!sess || !card || !card.getAttribute) return;
    var batchKey = card.getAttribute('data-batch-key');
    if (!batchKey || !sess.toolBatchesById || !sess.toolBatchesById[batchKey]) return;
    var batch = sess.toolBatchesById[batchKey];
    if (card.hasAttribute('data-batch-done')) return;
    card.setAttribute('data-batch-done', '1');
    batch.doneCount = (batch.doneCount || 0) + 1;
    updateBatchGroupHeaderExplicit(batch);
    if (batch.doneCount >= batch.batchSize) finishBatchGroup(sess, batch, batchKey);
}

/* 批量分组收尾：全部完成后头部转完成态。方案 A 允许部分 start/end 缺失，
   因此 finishStream 仍会对未闭合分组做最终视觉兜底。 */
function finishBatchGroup(sess, batch, batchKey) {
    if (!batch || !batch.groupEl) return;
    var group = batch.groupEl;
    var icon = $(group).find('.tool-batch-header .tool-status-icon').first()[0];
    if (icon) {
        setTimeout(function() {
            if (icon) {
                icon.className = 'tool-status-icon done';
                icon.innerHTML = '';
            }
        }, 300);
    }
    // 从 toolBatchesById 移除（已完成的批次无需继续持有）
    if (batchKey && sess.toolBatchesById) {
        delete sess.toolBatchesById[batchKey];
    }
}

/* 统一填充工具卡片结果体：命中专用 renderer 则用之，否则纯文本兜底；
   若结果被后端预览截断（meta.truncated），在体末追加「展开全文」按钮，点击按 seq 拉全文重渲染。 */
function fillToolBody(sess, bodyEl, toolName, text, args, meta) {
    if (!renderToolBody(bodyEl, toolName, text, args)) {
        bodyEl.textContent = text || '';
    }
    if (meta && meta.truncated && meta.seq) {
        appendExpandFullBtn(sess, bodyEl, toolName, args, meta);
    }
}

/* action_end 各配对/兜底路径共用：展示模型、参数、头部元数据与结果体一次回填。 */
function updateToolCardContent(sess, cardEl, toolName, toolTitle, args, text, meta, options) {
    var presentation = applyToolPresentation(cardEl, toolName, toolTitle, options);
    var bareToolName = presentation.bareToolName;
    updateToolHeaderMeta(cardEl, bareToolName, args, text);
    var argsStr = formatToolArgsStr(args);
    var argsEl = $(cardEl).find('.tool-args').first()[0];
    if (argsStr) {
        if (argsEl) argsEl.textContent = argsStr;
        else $('<span>').addClass('tool-args').text(argsStr).insertAfter($(cardEl).find('.tool-name').first());
    }
    var bodyEl = $(cardEl).find('.tool-card-body').first()[0];
    if (bodyEl) {
        bodyEl.removeAttribute('style');
        bodyEl.innerHTML = '';
        fillToolBody(sess, bodyEl, bareToolName, text, args, meta);
    }
    return bareToolName;
}

/* 为被截断的工具结果体追加「展开全文」按钮。点击调用 /web/chat/replay/full 按 seq 取全文，
   成功后用完整文本重渲染该体（去掉按钮）。拉取中禁用按钮防重复点击。 */
function appendExpandFullBtn(sess, bodyEl, toolName, args, meta) {
    var kb = meta.fullLength ? Math.round(meta.fullLength / 1024) : 0;
    var btn = $('<button>').addClass('tool-expand-full')
        .text(kb ? (GourdI18n.t('chat.expand_full_size', [kb])) : GourdI18n.t('chat.expand_full'))[0];
    btn.setAttribute('type', 'button');
    $(btn).on('click', function(e) {
        e.stopPropagation();   // 别冒泡到卡片头触发折叠
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = GourdI18n.t('chat.loading_dots');
        // 全文必须从卡片所属会话的根读取；用户切换项目后 currentProjectRoot 已不再代表本卡片。
        var sessionRoot = sess && sess.projectRoot ? sess.projectRoot : '';
        var rootQ = sessionRoot ? '&root=' + encodeURIComponent(sessionRoot) : '';
        $.get('/web/chat/replay/full?sessionId=' + encodeURIComponent(sess.sessionId)
                + '&seq=' + encodeURIComponent(meta.seq) + rootQ, function(resp) {
            var full = resp && resp.data;
            if (typeof full !== 'string' || !full) { btn.disabled = false; btn.textContent = GourdI18n.t('chat.expand_failed'); return; }
            bodyEl.removeAttribute('style');
            bodyEl.innerHTML = '';
            if (!renderToolBody(bodyEl, toolName, full, args)) { bodyEl.textContent = full; }
            if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(bodyEl);
            if (sess.sessionId === activeSessionId) scrollToBottom();
        }).fail(function() {
            btn.disabled = false;
            btn.textContent = GourdI18n.t('chat.expand_failed');
        });
    });
    bodyEl.appendChild(btn);
}

function appendActionEndChunk(sess, toolName, text, args, toolTitle, actionId, meta, agentBody, batchMeta, failed, durationMs) {
    // id 分支：并发/并行场景按 actionId 精确回填对应卡片（不依赖到达顺序），并推进批量分组进度。
    // 若正处于 HITL 审批结果回填态（sess.approvedToolCard 存在），让位给下方审批卡复用逻辑，避免两张卡。
    if (actionId && sess.completedActionIds && sess.completedActionIds[actionId]) return;
    if (actionId && !sess.approvedToolCard && sess.toolCardsById && sess.toolCardsById[actionId]) {
        var idCard = sess.toolCardsById[actionId];
        delete sess.toolCardsById[actionId];
        if (!sess.completedActionIds) sess.completedActionIds = {};
        sess.completedActionIds[actionId] = true;

        var idOwner = agentBody || resolveAgentCardBody(sess, args);
        toolName = updateToolCardContent(sess, idCard, toolName, toolTitle, args, text, meta,
            toolPresentationOptions(idOwner, args, idCard));
        setToolCardStatus(idCard, text, failed);
        setToolCardDuration(idCard, durationMs, failed);

        // 推进显式批量分组进度（方案 A）：根据卡片所属的 batchKey 定位批次，幂等推进。
        // 批次可能由 action_end 兜底创建，统一走 helper 保证计数口径一致。
        markBatchCardDone(sess, idCard);
        // 推进正文指针：新建空 .md-content 落在工具卡/分组「之后」，让工具执行完后到达的
        // text/agent 正文写入卡片下方，而非停留在旧气泡里被卡片顶到上方。
        // （与无 actionId 旧路径一致；缺此步会导致正文在上、工具卡垫底的错序渲染。）
        // 归属守卫：本卡属于智能体卡片内部时不动主对话正文指针，避免打断主气泡渲染；
        // 但智能体卡内部的正文指针同样要推进，让后续正文落在本卡之后（与主线路一致）
        if (!idOwner) {
            advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        } else {
            var idOwnerState = findAgentStateByBody(sess, idOwner) || resolveAgentState(sess, args);
            advanceAgentBodyPointer(sess, idOwnerState);
            // 工具卡结果体填充后卡体高度突变，需重新跟随到卡内底部
            followAgentCardBody(idOwner, idOwnerState);
        }
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    // 复用分支：若该工具卡由 action_start 提前创建（loading 中），直接填充结果体并转完成态，避免重复建卡
    if (sess.pendingToolStarted && sess.pendingToolCard) {
        var pc = sess.pendingToolCard;
        sess.pendingToolStarted = false;
        toolName = updateToolCardContent(sess, pc, toolName, toolTitle, args, text, meta,
            toolPresentationOptions(agentBody, args, pc));
        finishPendingTool(sess);
        setToolCardStatus(pc, text, failed);
        setToolCardDuration(pc, durationMs, failed);
        if (window._todoChunkHandlers) { /* todo 由 streaming 层单独处理，这里不重复 */ }
        // 归属守卫：该卡属于智能体卡片内部时不动主对话正文指针；卡内正文指针同样推进
        if (!$(pc).closest('.agent-card').length) {
            advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        } else {
            advanceAgentBodyPointer(sess, findAgentStateByCard(sess, $(pc).closest('.agent-card')[0]));
        }
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }
    if (actionId && sess.completedActionIds && sess.completedActionIds[actionId]) return;
    var endBatchMeta = normalizeBatchMeta(batchMeta);
    if (endBatchMeta) {
        if (actionId) {
            if (!sess.completedActionIds) sess.completedActionIds = {};
            sess.completedActionIds[actionId] = true;
        }
        var fallbackCard = $('<div>').addClass('tool-card')[0];
        if (sess.currentRunId) fallbackCard.setAttribute('data-run-id', sess.currentRunId);
        if (actionId) fallbackCard.setAttribute('data-action-id', actionId);
        if (window.cliPrintSimplified === false) $(fallbackCard).addClass('expanded');
        fallbackCard.innerHTML = '<div class="tool-card-header"><span class="tool-type-icon"></span><span class="tool-name"></span><span class="tool-status-icon loading"></span></div><div class="tool-card-body"></div>';
        var fallbackAgentBody = agentBody || resolveAgentCardBody(sess, args);
        toolName = updateToolCardContent(sess, fallbackCard, toolName, toolTitle, args, text, meta,
            toolPresentationOptions(fallbackAgentBody, args, fallbackCard));
        setToolCardStatus(fallbackCard, text, failed);
        setToolCardDuration(fallbackCard, durationMs, failed);
        $(fallbackCard).find('.tool-card-header').on('click', function() { $(fallbackCard).toggleClass('expanded'); });
        if (appendCardToBatch(sess, fallbackCard, endBatchMeta, fallbackAgentBody)) markBatchCardDone(sess, fallbackCard);
        else if (fallbackAgentBody) $(fallbackAgentBody).append(fallbackCard);
        else insertBeforeActions(sess, fallbackCard);
        if (fallbackAgentBody) advanceAgentBodyPointer(sess, findAgentStateByBody(sess, fallbackAgentBody));
        else advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    // 复用分支：若刚批准过 HITL，结果渲染进同一张审批卡片，避免出现两张卡
    if (sess.approvedToolCard) {
        var rc = sess.approvedToolCard;
        sess.approvedToolCard = null;
        toolName = updateToolCardContent(sess, rc, toolName, toolTitle, args, text, meta,
            toolPresentationOptions(agentBody, args, rc));
        setToolCardStatus(rc, text, failed);
        setToolCardDuration(rc, durationMs, failed);
        if (window.cliPrintSimplified === false) $(rc).addClass('expanded');
        else $(rc).removeClass('expanded');
        sess.pendingToolCard = rc;
        advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    var fallbackOwner = agentBody || resolveAgentCardBody(sess, args);
    var card = $('<div>').addClass('tool-card')[0];
    // 存储当前 runId，用于后续删除同一运行的消息
    if (sess.currentRunId) {
        card.setAttribute('data-run-id', sess.currentRunId);
    }
    if (window.cliPrintSimplified === false) $(card).addClass('expanded');
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-type-icon"></span>'
        + '<span class="tool-name"></span>'
        + '<span class="tool-status-icon loading"></span>'
        + '</div>'
        + '<div class="tool-card-body"></div>';
    toolName = updateToolCardContent(sess, card, toolName, toolTitle, args, text, meta,
        toolPresentationOptions(fallbackOwner, args, card));

    // 工具结果渲染：公共更新方法已按裸 toolName 委托注册表并处理纯文本兜底/截断按钮
    setToolCardStatus(card, text, failed);
    setToolCardDuration(card, durationMs, failed);

    $(card).find('.tool-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });

    // 归属守卫：子代理的工具结果（无 action_start 前置建卡时）同样插入智能体卡片内部
    if (fallbackOwner) {
        $(fallbackOwner).append(card);
        advanceAgentBodyPointer(sess, findAgentStateByBody(sess, fallbackOwner));
        sess.pendingToolCard = card;
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    insertBeforeActions(sess, card);
    sess.pendingToolCard = card;

    advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
    if (sess.sessionId === activeSessionId) scrollToBottom();
}

function appendContentChunk(sess, text, append) {
    appendBodyContentCore(sess, sess, text, append, function() {
        return ensureAssistantBubble(sess);
    });
}

function appendErrorChunk(sess, text) {
    ensureAssistantBubble(sess);
    var errEl = $('<div>').addClass('chunk-error').text(text)[0];
    insertBeforeActions(sess, errEl);
    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/**
 * 渲染「正在重试」提示。同一次推理回合内多次重试会复用同一个提示元素（只更新文案），
 * 避免堆叠多条。待后续真实内容（reason/text/action 等）到达时由 clearRetryChunk 清除。
 */
function appendRetryChunk(sess, text) {
    ensureAssistantBubble(sess);
    if (sess.retryEl && sess.retryEl.parentNode) {
        // 复用已有提示，仅更新文案
        var txt = $(sess.retryEl).find('.chunk-retry-text')[0];
        if (txt) txt.textContent = text;
    } else {
        var el = $('<div>').addClass('chunk-retry')[0];
        el.appendChild($('<span>').addClass('chunk-retry-spinner')[0]);
        el.appendChild($('<span>').addClass('chunk-retry-text').text(text)[0]);
        sess.retryEl = el;
        insertBeforeActions(sess, el);
    }
    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/**
 * 清除重试提示（重试后成功产出内容，或本轮结束时调用）。
 */
function clearRetryChunk(sess) {
    if (sess.retryEl) {
        if (sess.retryEl.parentNode) sess.retryEl.parentNode.removeChild(sess.retryEl);
        sess.retryEl = null;
    }
}

/* ===== Trace Badge =====
   只展示耗时。token 用量（输入/缓存/输出）故意不在此展示：
   本行数据源为 trace.getMetrics()，是「本轮累计」口径（所有 ReAct 迭代求和）；
   而工具栏的上下文进度环是「本次推理」口径（每轮 onReasonEnd 覆盖一次）。
   两者分母不同，数字天然对不上（尤其缓存命中率：累计值含首次冷缓存，按输入量加权后必然低于末次），
   并列展示会让用户误以为统计出错。故用量统一只在进度环展示一处。
   例外：outputTokens 仅作为 TPS 的分子参与计算，不以绝对量形式显示，不构成口径歧义。 */

/** HTML 转义（与 appendTraceBadge 内部 esc 同口径，供耗时详情卡复用）。 */
function traceEsc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

/**
 * 耗时徽标文本。
 * <p>优先用毫秒字段 {@code elapsedMs}（四舍五入到秒，比旧的向下截断更准：27.6s 旧显 27s、今显 28s）；
 * 旧历史帧没有该字段，回退整秒 {@code elapsedSeconds}，行为与改动前一致。</p>
 * @param {Object} chunk - trace 帧
 * @param {Function} fmtSec - 秒→人读文本的格式化函数
 * @returns {?string} 无任何耗时字段时返回 null
 */
function traceElapsedText(chunk, fmtSec) {
    if (chunk.elapsedMs != null && chunk.elapsedMs >= 0) {
        var s = Math.round(chunk.elapsedMs / 1000);
        // 亚秒轮次不写 "0s"（会被读成「没执行」）
        return s < 1 ? '<1s' : fmtSec(s);
    }
    if (chunk.elapsedSeconds != null) return fmtSec(chunk.elapsedSeconds);
    return null;
}

/**
 * 输出速度（TPS）文本。
 * <p><b>口径</b>：{@code generatedTokens / generationMs}——两个值由后端成对产出，
 * 统计范围严格一致：只计模型真正在解码的时间与那些解码段产出的 token，
 * 工具执行、审批等待、子代理调度均不在内。所以这是真实解码速度，可用于模型间横向比较。</p>
 * <p><b>为何不用 outputTokens 与 elapsedMs</b>：前者是整轮累计（还会并入子代理产出），
 * 后者含大量非解码时间，二者相除既不是解码速度也不是可比的吞吐量。</p>
 * <p><b>缺失即不展示</b>：旧历史帧没有这对字段，此时返回 null 让该行整行省略。
 * 绝不退回用总时长顶替——那会把一个口径不同的数字伪装成同一个指标。</p>
 * @param {Object} chunk - trace 帧
 * @returns {?string} 数据不足时返回 null
 */
function traceTpsText(chunk) {
    var tokens = chunk.generatedTokens;
    var genMs = chunk.generationMs;
    if (tokens == null || !(tokens > 0)) return null;
    if (genMs == null || !(genMs > 0)) return null;

    var tps = tokens / (genMs / 1000);
    if (!isFinite(tps) || !(tps > 0)) return null;

    var num = tps >= 100 ? Math.round(tps) : Math.round(tps * 10) / 10;
    return GourdI18n.t('chat.tps_unit').replace('{n}', num);
}

/**
 * 首 Token 延迟文本（不足 1 秒用 ms，否则用 2 位小数的秒）。
 * <p>该字段本次改动才新增，旧历史消息恒为 null，此时该行整行省略而非显示 0。</p>
 * @param {Object} chunk - trace 帧
 * @returns {?string} 无值时返回 null
 */
function traceTtftText(chunk) {
    if (chunk.ttftMs == null || !(chunk.ttftMs >= 0)) return null;
    var ms = chunk.ttftMs;
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (Math.round(ms / 10) / 100).toFixed(2) + 's';
}

/**
 * 构建耗时详情卡 HTML（悬停/聚焦 trace 徽标展开）。
 * <p><b>全部用 span 而非 div</b>：宿主 .trace-item 是 span，内嵌 div 会被 HTML 解析器
 * 提前断开 span，卡片会被抛出到徽标外面；块级布局全靠 CSS display 达成。</p>
 * <p>仅有总用时一项（TPS 与 TTFT 都缺失，如旧历史帧）时返回空串，
 * 调用方会退回原生 title 提示——只有一行与徽标重复的卡片没有信息增量。</p>
 * @param {Object} chunk - trace 帧
 * @param {string} elapsedTxt - 已格式化的总用时文本
 * @returns {string} 卡片 HTML，不值得展示时为空串
 */
function buildTracePop(chunk, elapsedTxt) {
    function row(label, value) {
        return '<span class="trace-pop-row">'
            + '<span class="trace-pop-label">' + traceEsc(label) + '</span>'
            + '<span class="trace-pop-value">' + traceEsc(value) + '</span>'
            + '</span>';
    }
    var tps = traceTpsText(chunk);
    var ttft = traceTtftText(chunk);
    if (!tps && !ttft) return '';

    var html = '<span class="trace-pop">'
        + '<span class="trace-pop-title">' + TRACE_TIME_SVG
        + traceEsc(GourdI18n.t('chat.turn_timing')) + '</span>'
        + row(GourdI18n.t('chat.elapsed_total'), elapsedTxt);
    if (tps) html += row(GourdI18n.t('chat.output_tps'), tps);
    if (ttft) html += row(GourdI18n.t('chat.ttft'), ttft);
    return html + '</span>';
}

function appendTraceBadge(sess, chunk) {
    ensureAssistantBubble(sess);
    // 后端携带的最终答案为权威复制源，写到当前 .md-content 的 data-md-raw（与历史消息统一属性名），供复制按钮读取。
    if (chunk.finalAnswer != null && sess.currentBubbleEl) {
        sess.currentBubbleEl.setAttribute('data-md-raw', chunk.finalAnswer);
    }
    function fmtSec(s) {
        if (s >= 3600) {
            var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
            return h + 'h' + (m > 0 ? ' ' + m + 'min' : '') + (r > 0 ? ' ' + r + 's' : '');
        }
        if (s >= 60) { var m = Math.floor(s / 60), r = s % 60; return r > 0 ? m + 'min ' + r + 's' : m + 'min'; }
        return s + 's';
    }
    // 图标化：以小图标替代“耗时”文字标签，节省横向空间；悬停/点击展开耗时详情卡承载完整语义
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    /**
     * 渲染一个耗时徽标。
     * <p>有详情卡时做成可聚焦的 disclosure（支持键盘与触屏）；无卡时退回纯展示 + 原生 title。
     * 属性按数组拼接而非在三元表达式里接半截引号：后者漏一个引号就会静默生成破碎 HTML。</p>
     */
    function item(icon, val, pop) {
        var cls = 'trace-item' + (pop ? ' has-pop' : '');
        var attrs = ' class="' + cls + '"';
        if (pop) {
            // 触屏与读屏软件依赖显式语义：纯 CSS :hover 在触屏上不可靠
            attrs += ' tabindex="0" role="button" aria-expanded="false"'
                + ' aria-label="' + esc(GourdI18n.t('chat.turn_timing')) + '"';
        } else {
            attrs += ' title="' + esc(GourdI18n.t('chat.elapsed_time')) + '"';
        }
        return '<span' + attrs + '><span class="trace-ic" aria-hidden="true">' + icon + '</span>'
            + esc(val) + (pop || '') + '</span>';
    }
    var parts = [];
    var elapsedTxt = traceElapsedText(chunk, fmtSec);
    if (elapsedTxt != null) parts.push(item(TRACE_TIME_SVG, elapsedTxt, buildTracePop(chunk, elapsedTxt)));
    if (parts.length === 0) return;

    // 创建或更新 trace 元素
    var row = sess.currentBubbleEl ? $(sess.currentBubbleEl).closest('.msg-row')[0] : null;
    if (!row) return;

    var metaRow = $(row).find('.msg-meta-row')[0];
    if (!metaRow) return;

    var traceEl = $(metaRow).find('.msg-trace')[0];
    if (traceEl) {
        // 已存在：更新内容（同一 trace 重复回放不得追加出第二个徽标）
        traceEl.innerHTML = parts.join('');
    } else {
        // 不存在：创建新的 trace 元素
        var badge = $('<span>').addClass('msg-trace');
        badge[0].innerHTML = parts.join('');
        $(metaRow).append(badge[0]);
    }

    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/* ---- 耗时详情卡：触屏/键盘开合 ----
   纯 CSS :hover 在触屏设备上不可靠（需要二次点击且无法关闭），故叠加一层显式开合：
   点击徽标切换 is-open，点击外部或按 Escape 关闭。所有绑定走 document 委托，
   因为徽标会被流式渲染与历史回放反复重建，直接绑定会失效。 */
function closeAllTracePops(exceptEl) {
    $('.trace-item.has-pop.is-open').each(function () {
        if (exceptEl && this === exceptEl) return;
        $(this).removeClass('is-open').attr('aria-expanded', 'false');
    });
}

$(document).on('click', '.trace-item.has-pop', function (e) {
    // 卡片内部点击（如选中数值）不应触发关闭
    if ($(e.target).closest('.trace-pop').length) return;
    e.stopPropagation();
    var willOpen = !$(this).hasClass('is-open');
    closeAllTracePops(this);
    $(this).toggleClass('is-open', willOpen).attr('aria-expanded', willOpen ? 'true' : 'false');
});

$(document).on('keydown', '.trace-item.has-pop', function (e) {
    // 键盘可达：Enter/Space 开合，Escape 关闭并保留焦点
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        $(this).trigger('click');
    } else if (e.key === 'Escape') {
        $(this).removeClass('is-open').attr('aria-expanded', 'false');
    }
});

$(document).on('click', function () { closeAllTracePops(null); });
$(document).on('keydown', function (e) { if (e.key === 'Escape') closeAllTracePops(null); });

/* ===== Agent Card (子代理智能体卡片 — 容器型)
   结构：
     .agent-card (容器外壳)
       .agent-card-header (头部：状态点 + 图标 + 标签 + 描述)
       .agent-card-body (完整内容体 — 复用外部主智能体样式：thinking-block / tool-card / md-content)
  
   agent_start 创建容器并登记到 sess.agentCards，agent_end 更新状态并追加 resultSummary。
   子代理内部复用外部主智能体的渲染流程，所有内容都插入到 .agent-card-body 内。 */
    function appendAgentBadge(sess, chunk, isStart) {
    var agentName = chunk.toolName || (chunk.args && chunk.args.agentName) || 'agent';
    var desc = chunk.text || (chunk.args && chunk.args.description) || '';
    var invocationId = chunk.args && chunk.args.invocationId;
    var agentId = invocationId || (agentName + ':' + desc);
            
    // agent_end：查找已有容器并更新
    if (!isStart) {
        if (sess.agentCards && sess.agentCards[agentId]) {
            var existCard = sess.agentCards[agentId];
            var statusIcon = $(existCard).find('.agent-status-icon').first()[0];
            var success = chunk.args && chunk.args.success !== false;
            if (statusIcon) {
                statusIcon.className = 'agent-status-icon ' + (success ? 'done' : 'reject');
            }

            // 强刷：确保该智能体 pending 的正文/思考都先渲染（按各自独立状态，支持并行）
            var endState = (sess.agentStates && sess.agentStates[agentId]) || null;
            if (endState) {
                if (endState.thinkingBlockEl) {
                    var endThinkingMd = endState.thinkingBodyMdEl;
                    if (endThinkingMd) {
                        getStreamMd(endThinkingMd).finish();
                        if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(endThinkingMd);
                        if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(endThinkingMd);
                    }
                    finishAgentThinkingBlock(sess, endState);
                }
                if (endState.currentBubbleEl && endState.bodyText) {
                    getStreamMd(endState.currentBubbleEl).finish();
                    if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(endState.currentBubbleEl);
                    if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(endState.currentBubbleEl);
                    if (typeof processMermaidBlocks === 'function') processMermaidBlocks(endState.currentBubbleEl);
                }
            }

            // 清扫卡体内视觉为空的正文容器（指针推进遗留的空 .md-content / 空 <p> 残留），
            // 统一卡体间隔（与主线路 finishStream 收尾清扫同口径）；放在 resultSummary 追加之前，
            // 确保摘要落在卡体真正的末尾。此时该智能体的增量渲染器已在上方强刷收敛，不会误删带内容的容器。
            purgeEmptyMdBlocks(existCard);

            // resultSummary 作为独立的 .md-content 块追加到 .agent-card-body 末尾。
            // 去重守卫：卡片已有流式正文时（单任务 ReasonDeltaEvent 增量 / multitask ReasonEndEvent 结果），
            // resultSummary 与其同文，成功时不再追加，避免卡片内同一段内容出现两次；
            // 失败（success=false）时 summary 承载错误信息，仍需追加。
            var hasStreamedBody = !!(endState && endState.bodyText && endState.bodyText.trim());
            if (chunk.args && chunk.args.resultSummary && (!success || !hasStreamedBody)) {
                var summaryMd = $('<div>').addClass('md-content').addClass('agent-result-summary')[0];
                summaryMd.innerHTML = renderMd(chunk.args.resultSummary);
                if (typeof addCodeBlockButtons === 'function') addCodeBlockButtons(summaryMd);
                if (typeof highlightCodeBlocks === 'function') highlightCodeBlocks(summaryMd);
                if (typeof processMermaidBlocks === 'function') processMermaidBlocks(summaryMd);
                var agentCardBody = $(existCard).find('.agent-card-body')[0];
                if (agentCardBody) agentCardBody.appendChild(summaryMd);
            }

            $(existCard).removeClass('agent-card-streaming');
            delete sess.agentCards[agentId];
            if (sess.agentStates) delete sess.agentStates[agentId];
            
            // 恢复 currentBubbleEl：在卡片后创建新的 md-content，让主代理后续正文不跑进智能体容器
            var newMdAfter = $('<div>').addClass('md-content')[0];
            insertBeforeActions(sess, newMdAfter);
            sess.currentBubbleEl = newMdAfter;
            sess.reasonBuffer = '';

            // 清除该智能体的活跃状态（仅清自己，不影响并行的其他智能体；
            // endState 为 null 时不降级为全量清理，避免误伤并行中的其他智能体）
            if (endState) {
                clearAgentState(sess, endState);
            }

            if (sess.sessionId === activeSessionId) {
                setTimeout(scrollToBottom, 50);
            }
            return;
        }
    }

    // 创建容器型智能体卡片
    var card = $('<div>').addClass('agent-card')[0];
    if (sess.currentRunId) card.setAttribute('data-run-id', sess.currentRunId);
    
    var statusClass = isStart ? 'loading' : 'done';
    var argsHtml = desc ? '<span class="tool-args">' + escapeHtml(desc) + '</span>' : '';
    card.innerHTML = '<div class="agent-card-header">'
        + '<span class="agent-status-icon ' + statusClass + '"></span>'
        + '<span class="agent-icon">' + AGENT_SVG + '</span>'
        + '<span class="agent-label" data-i18n="chat.agent_label">' + GourdI18n.t('chat.agent_label') + '</span>'
        + '<span class="agent-name">' + escapeHtml(agentName) + '</span>'
        + argsHtml
        + '</div>'
        + '<div class="agent-card-body"></div>';
    
    if (isStart) $(card).addClass('agent-card-streaming');
    if (window.cliPrintSimplified === false) $(card).addClass('expanded');
    
    $(card).find('.agent-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });
        
    insertBeforeActions(sess, card);

    var agentCardBody = $(card).find('.agent-card-body')[0];

    // 每个智能体一份独立输出状态（支持并行 multitask，避免多卡片内容互串）。
    // 字段名与主线路 sess 完全同名（currentBubbleEl=正文指针、thinkingBlockEl/thinkingBlockTimerId 等），
    // 智能体卡片内部 thus 直接复用主线路的共享渲染核心，保证两条线路渲染一致。
    var agentState = {
        id: agentId,
        card: card,
        bodyEl: agentCardBody,
        bodyUserScrolledUp: false,
        currentBubbleEl: null,
        bodyText: '',
        reasonBuffer: '',
        thinkingBlockEl: null,
        thinkingBodyMdEl: null,
        thinkingBodyWrapEl: null,
        thinkingBuffer: '',
        thinkingUserScrolledUp: false,
        thinkingBlockTimerId: null,
        thinkingBlockStartTime: null
    };
    // 监听卡体滚动：用户主动向上翻看时停止自动跟随（写入各智能体自身状态，并行互不污染，
    // 与思考块 thinkingUserScrolledUp 同口径）。
    //
    // 必须只认【真实的向上滚动】。旧实现用「gap > 60 即视为用户上翻」，会被两类非用户行为误触发：
    //   1) followAgentCardBody 的置底赋值也会触发本监听，而 scroll 事件是异步派发的；等回调真正
    //      执行时，卡体内的异步渲染（highlightCodeBlocks / processMermaidBlocks / 工具卡展开）
    //      往往已把 scrollHeight 撑大，gap 凭空超阈；
    //   2) 流式追加内容本身就会拉大 gap（scrollTop 不变、scrollHeight 变大）。
    // 而 bodyUserScrolledUp 一旦置 true，除非用户手动滚回底部否则永不复位（跟随已停，卡体再也不会
    // 自己走到底部）→ 自锁。表现为「子智能体卡片只有状态点在闪、内部不再加载任何消息」，
    // 而实际 DOM 一直在增长、后端也一直在推流，只是视口定格在锁死那一刻。
    //
    // 方向判据天然免疫于上述两类误触发：置底与内容增长都不会让 scrollTop 变小，只有用户上翻会。
    // 不用「程序置底标记 + 监听器消费」的方案：浏览器会合并 scroll 事件，且置底时位置未变则
    // 根本不派发事件，残留标记会吞掉用户的下一次真实滚动。
    $(agentCardBody).on('scroll', function() {
        var top = agentCardBody.scrollTop;
        var prev = agentState._lastBodyScrollTop == null ? top : agentState._lastBodyScrollTop;
        agentState._lastBodyScrollTop = top;
        var gap = agentCardBody.scrollHeight - top - agentCardBody.clientHeight;
        // 已在底部附近（含用户主动滚回底部）：无条件恢复跟随。
        // 内容被移除（purgeEmptyMdBlocks）导致浏览器回调 scrollTop 的场景也在此处被先行拦下。
        if (gap <= 60) { agentState.bodyUserScrolledUp = false; return; }
        // 仅当位置真的往上走了，才认定为用户在翻看历史内容。
        if (top < prev) agentState.bodyUserScrolledUp = true;
    });

    if (!sess.agentStates) sess.agentStates = {};
    sess.agentStates[agentId] = agentState;
    sess._agentStateLast = agentState;

    // 登记到 sess.agentCards 供后续工具调用嵌套
    if (isStart) {
        if (!sess.agentCards) sess.agentCards = {};
        sess.agentCards[agentId] = card;
    }

    if (sess.sessionId === activeSessionId) {
        setTimeout(scrollToBottom, 50);
    }
}

/* 清理子智能体相关状态。传入 st 时仅清理该智能体（并行场景互不影响）；不传则全量清理。
   opts.keepActive=true 时保留【卡片仍在文档中】的活跃子代理（见 isAgentStateAlive）：
   供 resetStreamState 这类「重置主线路流式状态、但不销毁会话 DOM」的路径使用。

   【回放期间强制不保留】sess._replaying 为真时 keepActive 一律失效，原因有二：
     1) 回放不需要它——prepend 回放自己会在开始前 captureLiveStreamState 快照 agentCards/
        agentStates/_agentStateLast，并在 replayDone 里整体写回（见 app-history.js），
        实时卡的存活由那条路径负责，比在这里逐个甄别可靠；
     2) 保留反而有害——回放期间 sess.container 仍是文档里的真实容器（只切 renderTarget），
        被保留的实时卡因此始终「在文档中」。回放正文走的是同一个 resolveAgentState，
        一旦历史帧与实时卡撞键（无 invocationId 的旧帧退化成 agentName+':'+desc，
        重复跑同名同描述的子代理即可撞上），历史内容会被写进正在跑的那张实时卡里。 */
function isAgentStateAlive(st) {
    return !!(st && st.card && document.contains(st.card));
}

function clearAgentState(sess, st, opts) {
    if (st) {
        if (st.currentBubbleEl && st.currentBubbleEl._streamMd) st.currentBubbleEl._streamMd.dispose();
        if (st.thinkingBodyMdEl && st.thinkingBodyMdEl._streamMd) st.thinkingBodyMdEl._streamMd.dispose();
        stopThinkingTimer(st, 'thinkingBlockTimerId', 'thinkingBlockStartTime');
        if (sess.agentStates) delete sess.agentStates[st.id];
        if (sess._agentStateLast === st) sess._agentStateLast = null;
        return;
    }
    var keepActive = !!(opts && opts.keepActive) && !(sess && sess._replaying);
    // 全量清理（流重置/会话切换）
    if (sess.agentStates) {
        var kept = {};
        for (var k in sess.agentStates) {
            var s = sess.agentStates[k];
            // 活跃子代理（卡片仍挂在文档里、agent_end 尚未到达）不得被主线路重置误伤：
            // 清掉它会让后续帧全部失去归属（漏进主对话）且卡片永远收不掉。
            if (keepActive && isAgentStateAlive(s)) { kept[k] = s; continue; }
            if (s.currentBubbleEl && s.currentBubbleEl._streamMd) s.currentBubbleEl._streamMd.dispose();
            if (s.thinkingBodyMdEl && s.thinkingBodyMdEl._streamMd) s.thinkingBodyMdEl._streamMd.dispose();
            stopThinkingTimer(s, 'thinkingBlockTimerId', 'thinkingBlockStartTime');
        }
        sess.agentStates = kept;
    }
    // agentCards 必须与 agentStates 同步清空：它以 invocationId（旧帧为 agentName+':'+desc）为键
    // 持有 .agent-card DOM 强引用，仅在配对 agent_end 到达时才 delete（见本文件 agent_end 分支）。
    // 中断/报错/丢帧时条目永久残留，会钉住已被 evictInactiveSessions 的 $(container).empty() 摘除的
    // 卡片子树，使其无法 GC（连带卡片内各 .md-content 上的 _streamMd.buf 全文），
    // 表现为「清了 DOM 内存却不降」。注意：断线恢复路径会先保存再回填 agentCards
    // （app-history.js 的 resumeState），此处清空不影响该路径。
    // keepActive 时只保留上方存活的那几张卡，两张表口径必须严格一致：
    // 漏留 agentCards 会造成「有卡无态」（resolveAgentState 拿到 null 但又进不了新建分支），
    // 漏留 agentStates 则会让 resolveAgentState 的 agentCards 存在性检查直接失败。
    if (keepActive && sess.agentCards) {
        var keptCards = {};
        for (var ck in sess.agentCards) {
            if (sess.agentStates && sess.agentStates[ck]) keptCards[ck] = sess.agentCards[ck];
        }
        sess.agentCards = keptCards;
        // _agentStateLast 是归属兜底（见下方 resolveAgentStateWithFallback 与 app-streaming.js），
        // 必须指向【两表都真的留下了】的状态：光判 isAgentStateAlive 不够——状态虽存活，
        // 但若它是无对应卡片的孤儿而被上方裁掉，再拿它兜底就会把内容写进一张已不再登记的卡。
        var lastId = sess._agentStateLast && sess._agentStateLast.id;
        if (!lastId || sess.agentStates[lastId] !== sess._agentStateLast || !keptCards[lastId]) {
            sess._agentStateLast = null;
        }
        return;
    }
    sess.agentCards = {};
    sess._agentStateLast = null;
}

/* 按 .agent-card-body 容器元素 / 卡片外壳元素反查归属的智能体状态（action_end 等只有元素的配对场景） */
function findAgentStateByBody(sess, bodyEl) {
    if (!bodyEl || !sess.agentStates) return null;
    for (var k in sess.agentStates) {
        if (sess.agentStates[k].bodyEl === bodyEl) return sess.agentStates[k];
    }
    return null;
}
function findAgentStateByCard(sess, cardEl) {
    if (!cardEl || !sess.agentStates) return null;
    for (var k in sess.agentStates) {
        if (sess.agentStates[k].card === cardEl || $.contains(sess.agentStates[k].card, cardEl)) return sess.agentStates[k];
    }
    return null;
}

/* 推进子智能体正文指针（镜像主线路 action_end 推进 currentBubbleEl 的机制）：
   思考块/工具卡产出后新开空 md-content 追加到卡体末尾，后续正文落在时序位置。 */
function advanceAgentBodyPointer(sess, st) {
    if (!st) return;
    advanceBodyPointer(sess, st, function(el) { st.bodyEl.appendChild(el); });
}

/* 在子智能体块内创建 thinking-block（复用主线路核心，新思考块按时序落在已有内容之后） */
function ensureAgentThinkingBlock(sess, st) {
    if (!st) return;
    ensureThinkingBlockCore(sess, st, {
        placeFresh: function(el) { st.bodyEl.appendChild(el); },
        placeBlock: function(block, pointerEl) {
            if (pointerEl && pointerEl.parentNode) $(pointerEl).before(block);
            else st.bodyEl.appendChild(block);
        }
    });
}

/* 结束子智能体的 thinking-block。不传 st 时结束所有正打开的智能体思考块。 */
function finishAgentThinkingBlock(sess, st) {
    if (!st) {
        if (sess.agentStates) {
            for (var k in sess.agentStates) {
                if (sess.agentStates[k].thinkingBlockEl) finishThinkingBlockCore(sess, sess.agentStates[k]);
            }
        }
        return;
    }
    finishThinkingBlockCore(sess, st);
}

/* 子代理 reason chunk → thinking-block（复用主线路核心） */
function appendAgentReasonChunk(sess, text, st) {
    if (!st) return;
    ensureAgentThinkingBlock(sess, st);
    appendReasonChunkCore(sess, st, text);
}

/* 子代理正文 chunk → md-content（复用主线路核心；正文容器首次到达时懒创建并追加到卡体末尾） */
function appendAgentBodyContent(sess, text, st) {
    if (!st) st = sess._agentStateLast;
    if (!st || !st.bodyEl) return;
    st.bodyText = (st.bodyText || '') + text;
    appendBodyContentCore(sess, st, text, true, function() {
        if (!st.currentBubbleEl || !document.contains(st.currentBubbleEl)) {
            var newBodyMd = $('<div>').addClass('md-content')[0];
            st.bodyEl.appendChild(newBodyMd);
            st.currentBubbleEl = newBodyMd;
        }
        return st.currentBubbleEl;
    });
}

/* ===== Command Output ===== */
function appendCommandOutput(sess, text) {
    ensureAssistantBubble(sess);
    var mdEl = $('<div>').addClass('md-content')[0];
    mdEl.innerHTML = renderMd(text);
    if (typeof processMermaidBlocks === 'function') processMermaidBlocks(mdEl);
    insertBeforeActions(sess, mdEl);
    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/* ===== Thinking Indicators ===== */
function stopThinkingTimer(sess, timerKey, startTimeKey) {
    if (sess[timerKey]) { clearInterval(sess[timerKey]); sess[timerKey] = null; }
    sess[startTimeKey] = null;
}

function startThinkingTimer(sess, timerKey, startTimeKey, currentTimerSpan) {
    sess[startTimeKey] = Date.now();
    if (sess[timerKey]) clearInterval(sess[timerKey]);
    function tick() {
        if (!currentTimerSpan || !currentTimerSpan.parentNode) { clearInterval(sess[timerKey]); sess[timerKey] = null; return; }
        var elapsed = Math.floor((Date.now() - sess[startTimeKey]) / 1000);
        $(currentTimerSpan).text(elapsed + 's');
    }
    tick();
    sess[timerKey] = setInterval(tick, 1000);
}

// 按相位给等待指示器换上真实语义文案。
// 过去两个等待指示器（.thinking-row / .inline-thinking）连文字都没有，只有三个点，
// 因此无论在哪个相位长得都一模一样；现按 phase 显示「思考中 / 输出中 / 等待响应」。
function applyPhaseLabel(el, phase) {
    if (!el) return;
    var labelEl = $(el).find('.thinking-phase-label').first()[0];
    if (!labelEl) return;
    // 防御：PHASE_* 常量定义在 app-streaming.js，若本文件先于它加载则运行时可能未就绪；
    // 指示器只会在流式期间被调用（彼时全部脚本已加载），此处仅作兼容兜底。
    var keys = (typeof PHASE_I18N_KEY !== 'undefined') ? PHASE_I18N_KEY : null;
    var waitKey = (typeof PHASE_WAITING !== 'undefined') ? PHASE_WAITING : 'waiting';
    var key = (keys && (keys[phase] || keys[waitKey])) || 'chat.phase_waiting';
    $(labelEl).text(GourdI18n.t(key));
    labelEl.setAttribute('data-i18n', key);
    $(el).attr('data-phase', phase || waitKey);
}

// 启动等待指示器：尚无气泡时，在消息区独立显示一行「圆点 + 相位文案 + Ns」
function showThinking(sess) {
    removeThinking(sess);
    sess.thinkingEl = $('<div>').addClass('thinking-row')[0];
    sess.thinkingEl.innerHTML = '<div class="thinking-bubble">' + DOTS_HTML
        + '<span class="thinking-phase-label"></span>'
        + '<span class="thinking-timer-wrap">'
        + '<span class="thinking-current-timer">0s</span>'
        + '</span></div>';
    $(renderRoot(sess)).append(sess.thinkingEl);
    applyPhaseLabel(sess.thinkingEl, sess.phase);
    var currentTimerSpan = $(sess.thinkingEl).find('.thinking-current-timer')[0];
    startThinkingTimer(sess, 'thinkingTimerId', 'thinkingStartTime', currentTimerSpan);
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}
function removeThinking(sess) {
    stopThinkingTimer(sess, 'thinkingTimerId', 'thinkingStartTime');
    if (sess.thinkingEl) { $(sess.thinkingEl).remove(); sess.thinkingEl = null; }
}

// 气泡内的间隙等待指示器（「圆点 + 相位文案 + Ns」）。
// 关键：元素一旦创建便常驻气泡底部（actions 之前），不可见时用 visibility:hidden 占位，
// 避免显隐导致的高度跳动；流式结束时再由 purgeInlineThinking 彻底移除。
function ensureInlineThinking(sess) {
    if (!sess.currentBubbleEl) return null;
    if (sess.inlineThinkingEl && sess.inlineThinkingEl.parentNode) return sess.inlineThinkingEl;
    var el = $('<div>').addClass('inline-thinking hidden-reserve')[0];
    el.innerHTML = DOTS_HTML + '<span class="thinking-phase-label"></span>'
        + '<span class="thinking-timer-wrap">'
        + '<span class="thinking-current-timer">0s</span>'
        + '</span>';
    sess.inlineThinkingEl = el;
    // 指示器固定在正文底部、页脚（meta 行/操作按钮）之上，使正文与用量行的相对顺序恒为「正文 → meta」。
    var bubble = sess.currentBubbleEl.parentNode;
    var footer = $(bubble).find('.msg-meta-row').first()[0] || $(bubble).find('.msg-actions').first()[0];
    if (footer) $(footer).before(el);
    return el;
}
function showInlineThinking(sess, phase) {
    var el = ensureInlineThinking(sess);
    if (!el) return;
    $(el).removeClass('hidden-reserve');
    applyPhaseLabel(el, phase || sess.phase);
    var currentTimerSpan = $(el).find('.thinking-current-timer')[0];
    startThinkingTimer(sess, 'inlineThinkingTimerId', 'inlineThinkingStartTime', currentTimerSpan);
    if (sess.sessionId === activeSessionId) scrollToBottom();
}
function removeInlineThinking(sess) {
    stopThinkingTimer(sess, 'inlineThinkingTimerId', 'inlineThinkingStartTime');
    if (sess.inlineThinkingEl) { $(sess.inlineThinkingEl).addClass('hidden-reserve'); }
}
function purgeInlineThinking(sess) {
    stopThinkingTimer(sess, 'inlineThinkingTimerId', 'inlineThinkingStartTime');
    if (sess.inlineThinkingEl) { $(sess.inlineThinkingEl).remove(); sess.inlineThinkingEl = null; }
}



/* ===== HITL ===== */
/* actionId：触发审批的那次调用标识（由后端 hitl 帧透传，同源于 action_draft）。
   仅用于精确接管骨架卡，不登记到 sess.toolCardsById —— 审批通过后会重新走 Reason，
   届时 action_start 携带的是【新的】actionId 并由 sess.approvedToolCard 分支接管同一张卡
   （见 appendActionStartChunk），此处若按旧 id 登记只会留下一条永不被消费的悬挂引用。 */
/* 审批卡待定态的警示图标：appendHitlCard 初始渲染与 restoreHitlCardPending 失败恢复共用。 */
var HITL_WARN_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="6" x2="12" y2="14"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>';

function appendHitlCard(sess, toolName, command, actionId) {
    ensureAssistantBubble(sess);
    var presentation = resolveToolPresentation(toolName, null);
    toolName = presentation.bareToolName;

    // 采用 tool-card 视觉体系：审批通过后原地复用为工具结果卡片
    var argsHtml = command ? '<span class="tool-args">' + escapeHtml(command) + '</span>' : '';
    // 优先接管骨架卡（action_draft 已建、尚未收到 action_start）。不接管则同一工具会出现两张卡，
    // 其中骨架卡永久 loading（它等不到 action_start：批准后的 action_start 会被审批卡复用分支接走）。
    var card = takeoverArgsStreamingCard(sess, toolName, actionId);
    if (card) {
        $(card).addClass('hitl-pending expanded');
    } else {
        card = $('<div>').addClass('tool-card hitl-pending expanded')[0];
        // 存储当前 runId，用于后续删除同一运行的消息
        if (sess.currentRunId) {
            card.setAttribute('data-run-id', sess.currentRunId);
        }
    }
    card.setAttribute('data-tool-name', toolName);
    // 供提交失败恢复使用（restoreHitlCardPending 从属性重建上下文；不改 handleHitlResponse
    // 签名传卡引用——契约测试锁定了该函数与 appendHitlCard 内调用点的字面形态）
    card.setAttribute('data-hitl-action-id', actionId || '');
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-name">' + GourdI18n.t('chat.need_auth') + escapeHtml(presentation.displayName || 'unknown') + '</span>'
        + argsHtml
        + '<span class="tool-status-icon warn">' + HITL_WARN_SVG + '</span>'
        + '</div>'
        + '<div class="tool-card-body">' + (command ? escapeHtml(command) : GourdI18n.t('chat.waiting_auth')) + '</div>'
        + '<div class="hitl-card-actions">'
        + '<button class="hitl-btn hitl-btn-approve" data-i18n="chat.approve">' + GourdI18n.t('chat.approve') + '</button>'
        + '<button class="hitl-btn hitl-btn-reject" data-i18n="chat.reject">' + GourdI18n.t('chat.reject') + '</button>'
        + '</div>';
    (function() {
        var hn = $(card).find('.tool-name')[0];
        if (hn) { hn.setAttribute('data-i18n-hitl', 'need_auth'); hn.setAttribute('data-i18n-hitl-tool', toolName || 'unknown'); }
    })();

    $(card).find('.tool-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });

    // 接管骨架卡时节点已在消息流中（可能在智能体卡内），重插会把它搬到主对话底部
    if (!card.parentNode) insertBeforeActions(sess, card);

    var approveBtn = $(card).find('.hitl-btn-approve')[0];
    var rejectBtn = $(card).find('.hitl-btn-reject')[0];

    $(approveBtn).on('click', function() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        // 转为"执行中"，标记后续 action 结果复用此卡片
        var icon = $(card).find('.tool-status-icon')[0];
        if (icon) { icon.className = 'tool-status-icon loading'; icon.innerHTML = ''; }
        $(card).find('.hitl-card-actions').remove();
        $(card).removeClass('hitl-pending');
        sess.approvedToolCard = card;
        sess.pendingHitlCard = card;   // 供提交失败回退恢复（见 restoreHitlCardPending）
        handleHitlResponse(sess, 'approve', actionId);
    });

    $(rejectBtn).on('click', function() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        var icon = $(card).find('.tool-status-icon')[0];
        if (icon) { icon.className = 'tool-status-icon reject'; icon.innerHTML = ''; }
        $(card).find('.tool-name').text(GourdI18n.t('chat.rejected') + (presentation.displayName || 'unknown'));
        (function() { var hn = $(card).find('.tool-name')[0]; if (hn) { hn.setAttribute('data-i18n-hitl', 'rejected'); hn.setAttribute('data-i18n-hitl-tool', toolName || 'unknown'); } })();
        $(card).find('.hitl-card-actions').remove();
        $(card).removeClass('hitl-pending expanded');
        sess.approvedToolCard = null;
        sess.pendingHitlCard = card;   // 供提交失败回退恢复（见 restoreHitlCardPending）
        handleHitlResponse(sess, 'reject', actionId);
    });

    if (sess.sessionId === activeSessionId) scrollToBottom();
}

/* actionId：本张审批卡所对应的那一次工具调用标识（appendHitlCard 渲染时已持有）。
   必须随决策一起提交：后端只按 sessionId 取「当前待处理任务」，旧页面/旧卡的迟到点击
   会被应用到【另一次】调用上。工具审批一旦误批准不可逆（rm -rf 之类），故后端对本路径的
   校验比问答更严：带了 actionId 就必须与挂起任务完全一致，不一致直接拒绝（HTTP 409）。 */
function handleHitlResponse(sess, action, actionId) {
    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }
    resetStreamState(sess);

    sess.isStreaming = true;
    if (sess.sessionId === activeSessionId) {
        isStreaming = true;
        setBtnStopMode();
    }
    showThinking(sess);

    // 通过统一提交入口发送 HITL 决策，结果通过 WebSocket 推送。
    // 不带 input 键：后端靠它的存在性区分「新一轮」与「续轮」。
    var fields = { hitlAction: action };
    // 空值不入表：后端据「是否携带 actionId」区分【严格校验】与【旧前端降级】两种模式，
    // 补空串会让旧快照恢复而来的无 id 审批任务也走进严格分支，永远批不动。
    if (actionId) fields.actionId = actionId;
    postChatInput(sess, fields, null, {
        onFail: function(err) {
            console.error('HITL error:', err);
            // 通过回调占位调用 finishStream（由 app-streaming.js 注册）
            if (onFinishStream) onFinishStream(sess);
            // 失败回退：恢复待审批态允许重试（409 迟到点击被拒/网络错误同走此路）。
            // 按钮已随提交移除、状态已转终态，不恢复即交互死胡同——挂起任务永远无人应答。
            // 与问答卡路径的「失败回退」（state.submitted = false + syncQuestionCard）同构。
            restoreHitlCardPending(sess, sess.pendingHitlCard);
        }
    });
}

/* HITL 提交失败后把卡片恢复为待审批态：上下文（工具名/actionId）从卡片属性重建，
   按钮绑定与 appendHitlCard 的初始绑定镜像（两处如改一处必须同步另一处）。 */
function restoreHitlCardPending(sess, card) {
    if (!card || !card.parentNode) return;

    var toolName = card.getAttribute('data-tool-name') || 'unknown';
    var actionId = card.getAttribute('data-hitl-action-id') || null;
    var presentation = resolveToolPresentation(toolName, null);

    var icon = $(card).find('.tool-status-icon')[0];
    if (icon) { icon.className = 'tool-status-icon warn'; icon.innerHTML = HITL_WARN_SVG; }
    var hn = $(card).find('.tool-name')[0];
    if (hn) {
        hn.setAttribute('data-i18n-hitl', 'need_auth');
        hn.setAttribute('data-i18n-hitl-tool', toolName);
        $(hn).text(GourdI18n.t('chat.need_auth') + (presentation.displayName || 'unknown'));
    }
    if (!$(card).find('.hitl-card-actions').length) {
        $(card).append('<div class="hitl-card-actions">'
            + '<button class="hitl-btn hitl-btn-approve" data-i18n="chat.approve">' + GourdI18n.t('chat.approve') + '</button>'
            + '<button class="hitl-btn hitl-btn-reject" data-i18n="chat.reject">' + GourdI18n.t('chat.reject') + '</button>'
            + '</div>');
    }
    $(card).addClass('hitl-pending');
    if (sess.approvedToolCard === card) sess.approvedToolCard = null;
    if (sess.pendingHitlCard === card) sess.pendingHitlCard = null;

    var approveBtn = $(card).find('.hitl-btn-approve')[0];
    var rejectBtn = $(card).find('.hitl-btn-reject')[0];

    $(approveBtn).off('click').on('click', function() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        // 转为"执行中"，标记后续 action 结果复用此卡片
        var ic = $(card).find('.tool-status-icon')[0];
        if (ic) { ic.className = 'tool-status-icon loading'; ic.innerHTML = ''; }
        $(card).find('.hitl-card-actions').remove();
        $(card).removeClass('hitl-pending');
        sess.approvedToolCard = card;
        sess.pendingHitlCard = card;
        handleHitlResponse(sess, 'approve', actionId);
    });

    $(rejectBtn).off('click').on('click', function() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        var ic = $(card).find('.tool-status-icon')[0];
        if (ic) { ic.className = 'tool-status-icon reject'; ic.innerHTML = ''; }
        $(card).find('.tool-name').text(GourdI18n.t('chat.rejected') + (presentation.displayName || 'unknown'));
        (function() { var h = $(card).find('.tool-name')[0]; if (h) { h.setAttribute('data-i18n-hitl', 'rejected'); h.setAttribute('data-i18n-hitl-tool', toolName); } })();
        $(card).find('.hitl-card-actions').remove();
        $(card).removeClass('hitl-pending expanded');
        sess.approvedToolCard = null;
        sess.pendingHitlCard = card;
        handleHitlResponse(sess, 'reject', actionId);
    });
}

/* ===== 结构化问答卡（ask_user） =====
   与 HITL 审批卡（消息流内、审批即放行）不同：问答卡是一张悬浮于输入框上方的交互卡片，
   承载「一至多道带选项的提问」。用户逐题作答/补充/跳过后一次性提交，或点 X 跳过剩余直接提交
   （防任务卡死）。状态挂在会话（sess._questionState），卡片只渲染当前活动会话的那一份：
   切走即隐藏，切回时由 loadMessages→replaySession 对 question / question_answered 帧的顺序
   重放自然重建（历史中问后有答则重建后随即隐藏）。
   帧契约（冻结）：question {actionId, toolName:"ask_user", args:{questions:[{header, detail?, options?:[{label, recommended?}]}]}}；
   question_answered {args:{answers:[...]}}，收到即隐藏。
   提交：POST /web/chat/input（SSE_ENDPOINT），FormData questionAnswer=JSON.stringify({answers:[{index,text,skipped,custom}]})
   + sessionId；本地流式态处理与 handleHitlResponse 同构（进入流式态→POST→失败回退）。 */

/* ---- 问答卡状态机（纯函数；行为测试整段提取执行，区块内不得引用 DOM/全局） ---- */

/* 选项呈现整形阈值与词表。

   取证（146 个会话 / 66 张卡 / 142 题 / 419 个选项）：label 中位 40 字、p90 111、最长 321，
   379/419（90%）是「标题：解释」整段塞一起的形态，另有 80 个 label 自带「推荐」字样而
   recommended 又同时为真；detail 中位 115 字、p90 280、最长 794。原样渲染就是一屏长段落，
   用户「选个选项得看半天」，推荐标记还会重复出现两次。

   整形只作用于展示：出站答案与选中判定一律用【原始 label】（见 applyQuestionOptionAnswer
   写入的 selectedLabel），故答案协议、后端 formatAnswerText 与既有契约测试全部不受影响。 */
/* 标题长度区间（码点）。下限取 2 而不是 4：取证里「方案A——…」「A｜…」是高频形态，
   「方案A」只有 3 字却是有意义的标题，下限过大会把它们整段不拆地渲染成长行。
   单字标题仍不合格（劈出「A」等于没有标题），序号徽章已经承担编号职责。 */
var QUESTION_LABEL_TITLE_MIN = 2;
var QUESTION_LABEL_TITLE_MAX = 24;
/* 候选分隔符：冒号、竖线、破折号、" - "。逗号/分号刻意不入表——它们常出现在标题内部
   （如「方案一 · 止血（最小改动，约 2 个文件）」），按逗号劈会把标题切碎。 */
var QUESTION_LABEL_SEPARATORS = ['：', ':', '｜', '|', '——', '—', ' - '];
/* 标题里自带的推荐字样：只认「推荐/推薦/recommended/rec」，不认「建议」——
   后者常是正文语义（如「采纳建议」），剥掉会改变含义。仅在 recommended 为真时才剥。 */
var QUESTION_RECO_LEAD_RE = /^[\s|｜·•\-\u2014\u2013]*[(\[【（]?\s*(?:推荐|推薦|recommended|rec(?![a-z]))\s*[)\]】）]?[\s:：|｜·•\-\u2014\u2013]*/i;
var QUESTION_RECO_TAIL_RE = /[\s,，、|｜·•\-\u2014\u2013]*[(\[【（]?\s*(?:推荐|推薦|recommended|rec(?![a-z]))\s*[)\]】）]?[\s.。!！?？]*$/i;
/* detail 折叠阈值：超过任一即默认收起（取证 p50=115，阈值取 120 让约半数长说明收起）。 */
var QUESTION_DETAIL_COLLAPSE_CHARS = 120;
var QUESTION_DETAIL_COLLAPSE_LINES = 3;

/* 字数按码点计（CJK 一字一计），与 String.length 在代理对上不同；仅用于阈值判定。 */
function questionTextLen(text) {
    var s = (text == null) ? '' : String(text);
    return (typeof Array.from === 'function') ? Array.from(s).length : s.length;
}

/* 把「标题：解释」形态的长 label 拆成短标题 + 说明。
   取【最靠前的、能让标题落在 4~24 字区间】的分隔点：最靠前保证标题尽量短（可扫读），
   区间下限避免劈出「A」这种无意义标题，上限避免把长句从中间截断。
   找不到合格分隔点时整段作标题——短 label 本就不需要拆。 */
function splitQuestionLabel(label) {
    var text = (label == null) ? '' : String(label);
    var bestAt = -1;
    var bestSep = '';
    for (var i = 0; i < QUESTION_LABEL_SEPARATORS.length; i++) {
        var sep = QUESTION_LABEL_SEPARATORS[i];
        var at = text.indexOf(sep);
        if (at <= 0) continue;
        var headLen = questionTextLen(text.slice(0, at));
        if (headLen < QUESTION_LABEL_TITLE_MIN || headLen > QUESTION_LABEL_TITLE_MAX) continue;
        if (bestAt < 0 || at < bestAt) { bestAt = at; bestSep = sep; }
    }
    if (bestAt < 0) return { title: text, desc: '' };
    // 说明开头若紧跟破折号/空白（「标题：—— 说明」形态），一并吃掉
    var desc = text.slice(bestAt + bestSep.length).replace(/^[\s\-\u2014\u2013]+/, '');
    return { title: text.slice(0, bestAt), desc: desc };
}

/* 剥掉标题里自带的推荐字样（配合 recommended 胶囊去重）。
   剥完为空则回退原标题（整段只有「推荐」二字时不能把标题剥没）；
   剥完可能留下悬空分隔符（如「B｜推荐」→「B｜」），末尾统一清理。 */
function stripQuestionRecoWord(title) {
    var raw = (title == null) ? '' : String(title);
    var out = raw.replace(QUESTION_RECO_LEAD_RE, '');
    if (!out.trim()) out = raw;
    out = out.replace(QUESTION_RECO_TAIL_RE, '');
    if (!out.trim()) out = raw;
    out = out.replace(/[\s:：|｜·•\-\u2014\u2013]+$/, '');
    return out.trim() || raw.trim();
}

/* 选项的展示视图：{title, desc, label}。label 始终是原始值（出站与选中判定用它）。
   模型已给 description（或旧字段 detail）时直接采用、绝不改动 label；否则按分隔符兜底拆分，
   保证旧模型/存量会话的长 label 同样能扫读。 */
function questionOptionView(option) {
    var o = option || {};
    var label = (o.label == null) ? '' : String(o.label);
    var rawDesc = (o.description == null) ? o.detail : o.description;
    var desc = (rawDesc == null) ? '' : String(rawDesc).trim();
    var title = label;
    if (!desc) {
        var split = splitQuestionLabel(label);
        title = split.title;
        desc = split.desc;
    }
    if (o.recommended) {
        title = stripQuestionRecoWord(title);
        /* 剥推荐字样可能把标题剥塌（真实形态「B｜推荐：提示词硬规则 + A」→ 拆出「B｜推荐」
           → 剥完只剩「B」），一个字的标题等于没有标题。此时真正的标题在说明的第一句里，
           取过来顶上，剩余说明继续作 desc —— 编号信息不丢（序号徽章 + 出站 label 原文都在）。 */
        if (questionTextLen(title) < QUESTION_LABEL_TITLE_MIN && desc) {
            var lifted = liftFirstSentence(desc);
            if (questionTextLen(lifted.head) >= QUESTION_LABEL_TITLE_MIN) {
                title = lifted.head;
                desc = lifted.rest;
            }
        }
        /* 说明末尾的推荐字样也要剥（真实形态「方案B：补齐信号源，根治（推荐）」拆分后
           desc 仍以「（推荐）」收尾）。推荐已由强调色胶囊统一表达一次，重复出现既冗余
           又让胶囊失去意义。只剥末尾括号形态，不动句中的「推荐」（那可能是正文语义）。 */
        if (desc) {
            var trimmedDesc = desc.replace(/[\s,，、]*[(\[【（]\s*(?:推荐|推薦|recommended|rec(?![a-z]))\s*[)\]】）][\s.。!！?？]*$/i, '');
            if (trimmedDesc.trim()) desc = trimmedDesc.trim();
        }
    }
    return { title: title, desc: desc, label: label };
}

/* 取出第一句作标题，其余作说明。按句末标点切；第一句仍超长时（说明没有句子结构）
   返回空 rest 由调用方按长度复核，绝不硬截断语义。 */
function liftFirstSentence(desc) {
    var text = (desc == null) ? '' : String(desc).trim();
    var m = text.match(/^(.*?[。．.！!？?；;\n])\s*([\s\S]*)$/);
    if (m && m[1]) {
        // 句末标点保留在标题里会显得冗余，去掉后不影响语义
        return { head: m[1].replace(/[。．.！!？?；;\n]+$/, '').trim(), rest: (m[2] || '').trim() };
    }
    return { head: text, rest: '' };
}

/* 题面补充说明是否需要折叠（默认收起 + 「展开」按钮）。空说明不折叠。 */
function questionDetailShouldCollapse(detail) {
    var t = (detail == null) ? '' : String(detail);
    if (!t.trim()) return false;
    if (questionTextLen(t) > QUESTION_DETAIL_COLLAPSE_CHARS) return true;
    return t.split('\n').length > QUESTION_DETAIL_COLLAPSE_LINES;
}

function normalizeQuestionArgs(args) {
    var list = (args && args.questions) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var q = list[i] || {};
        var opts = [];
        var rawOpts = q.options || [];
        for (var j = 0; j < rawOpts.length; j++) {
            var o = rawOpts[j] || {};
            /* description 为可选新增字段；detail 是模型自发用过的别名（取证：419 个选项里
               7 个传 description、3 个传 detail），一并收下——旧实现只取 label/recommended，
               这些已经带上说明的选项反而被丢掉，等于惩罚了写得最规范的调用。 */
            var rawDesc = (o.description == null) ? o.detail : o.description;
            opts.push({
                label: (o.label == null) ? '' : String(o.label),
                description: (rawDesc == null) ? '' : String(rawDesc).trim(),
                recommended: !!o.recommended
            });
        }
        out.push({
            header: (q.header == null) ? '' : String(q.header),
            detail: (q.detail == null) ? '' : String(q.detail),
            options: opts
        });
    }
    return out;
}

/* detailOpen：按题号记录「补充说明是否展开」（默认收起，长 detail 不该把选项顶到屏外）。
   纯展示态，不入出站 payload；整卡重建时由它还原展开状态，不会因勾选/翻页而丢失。 */
function createQuestionCardState(actionId, questions) {
    return {
        actionId: actionId || '',
        questions: questions || [],
        answers: {},
        drafts: {},
        detailOpen: {},
        current: 0,
        submitted: false
    };
}

function questionAnswerFor(state, index) {
    return (state && state.answers && state.answers[index]) || null;
}

/* 选项高亮判定：以 selectedLabel 为准（text 可能已拼入补充，不再等于纯标签）。
   旧状态无 selectedLabel 字段时退回 text 比对，保证已落盘/已渲染的卡不闪失高亮。 */
function questionOptionSelected(state, index, label) {
    var a = questionAnswerFor(state, index);
    if (!a || a.skipped) return false;
    var want = (label == null) ? '' : String(label);
    if (a.selectedLabel != null) return a.selectedLabel === want;
    return !a.custom && a.text === want;
}

/* 出站文本组装：点选选项与额外补充并存时拼成一段。
   答案协议只有 text 一个载荷字段（已冻结，后端与测试都依赖），故拼接在客户端完成；
   采用单行「选项（补充：XXX）」形态，与后端 formatAnswerText 既有的
   「（用户自定义回答）」括号风格一致，模型侧读起来是完整一句而非断裂的多行。 */
function composeQuestionAnswerText(selectedLabel, supplement) {
    var sel = (selectedLabel == null) ? '' : String(selectedLabel).trim();
    var sup = (supplement == null) ? '' : String(supplement).trim();
    if (!sel) return sup;
    if (!sup) return sel;
    return sel + '（补充：' + sup + '）';
}

function questionIsAllAnswered(state) {
    if (!state || !state.questions || state.questions.length === 0) return false;
    for (var i = 0; i < state.questions.length; i++) {
        if (!state.answers[i]) return false;
    }
    return true;
}

/* 除 index 以外的题是否都已有着落（已答或已跳过）：用于判断「确认当前题之后能否直接提交」。
   单题场景下恒为真——所以单题打完字，按钮显示「发送」而不是无处可去的「下一步」。 */
function questionOthersAllAnswered(state, index) {
    if (!state || !state.questions || state.questions.length === 0) return false;
    for (var i = 0; i < state.questions.length; i++) {
        if (i !== index && !state.answers[i]) return false;
    }
    return true;
}

/* 当前题是否存在「已经打了字、但还没确认成答案」的输入。两个输入面各查一处：
   ① 卡片内补充行的草稿（input 事件实时回写 drafts，Enter 之前不进 answers）；
   ② 底部主输入框的文本（由调用方读出后以 boxText 传入，本区块保持纯函数）。
   与已入库 supplement 完全相同的草稿不算新输入（幂等，与 harvestQuestionInputOnSubmit 同口径）。
   已明确跳过的题一律返回 false：与收割函数「尊重放弃意图」的口径一致，
   不让输入框里的残留文本把一道已跳过的题复活。 */
function questionHasPendingInput(state, boxText) {
    if (!state || !state.questions || state.questions.length === 0) return false;
    var idx = state.current;
    var applied = questionAnswerFor(state, idx);
    if (applied && applied.skipped) return false;
    if (String(boxText == null ? '' : boxText).trim()) return true;
    if (!state.drafts || !Object.prototype.hasOwnProperty.call(state.drafts, idx)) return false;
    var draft = String(state.drafts[idx] == null ? '' : state.drafts[idx]).trim();
    if (!draft) return false;
    var appliedSup = (applied && applied.supplement) ? String(applied.supplement).trim() : '';
    return draft !== appliedSup;
}

/* 底部按钮三态判定：submit = 提交全部；next = 确认本题后翻到下一题；skip = 本题记为跳过后翻页。
   文案与点击行为共用这一个判据，二者永不脱节。

   【为什么不能只看 questionIsAllAnswered】旧实现两态（全答=发送，否则=跳过）漏掉了两种情形：
   ① 用户在输入框打了字但没按 Enter —— 答案还没入库，按钮写着「跳过」，点下去走
      skipQuestionAnswer 把本题标记为 skipped，而收割函数遇到 skipped 会早退，
      那段文字彻底丢失（用户看到的症状就是「填了文本框按钮还是跳过」）；
   ② 当前题已点选选项、只是别的题还没答 —— 按钮同样写「跳过」，但点下去并不会跳过
      已答的题（skipQuestionAnswer 只对无答案的题置 skipped），实际只是翻页，文案骗人。 */
function questionSubmitMode(state, boxText) {
    if (questionIsAllAnswered(state)) return 'submit';
    if (!state || !state.questions || state.questions.length === 0) return 'skip';
    var idx = state.current;
    if (!questionAnswerFor(state, idx) && !questionHasPendingInput(state, boxText)) return 'skip';
    return questionOthersAllAnswered(state, idx) ? 'submit' : 'next';
}

function advanceQuestionCursor(state) {
    if (!state || !state.questions) return;
    if (state.current < state.questions.length - 1) state.current += 1;
}

/* 从 index 之后开始环绕查找第一道【尚无任何状态】的题，找不到返回 -1。
   「下一步」必须用它而不是 advanceQuestionCursor：后者只会 +1 且在末题是空操作，
   若用户先跳到最后一题作答（前面还空着），点「下一步」光标原地不动 = 按钮点了没反应，
   且此时 mode 恒为 next（本题已有答案、别题未答）→ 永远点不动，只能走 X 放弃剩余题。
   环绕查找保证「下一步」始终落到真正待办的那道题上。 */
function nextUnansweredQuestionIndex(state, index) {
    if (!state || !state.questions || state.questions.length === 0) return -1;
    var n = state.questions.length;
    for (var step = 1; step <= n; step++) {
        var i = (index + step) % n;
        if (!state.answers[i]) return i;
    }
    return -1;
}

function applyQuestionOptionAnswer(state, index, label) {
    if (!state) return;
    var sel = (label == null) ? '' : String(label);
    // 改选别的选项时保留已写的补充：用户先补一句再换选项，补充不该被顶掉
    var prev = questionAnswerFor(state, index);
    var sup = (prev && prev.supplement) ? String(prev.supplement) : '';
    state.answers[index] = {
        index: index,
        text: composeQuestionAnswerText(sel, sup),
        selectedLabel: sel,
        supplement: sup,
        skipped: false,
        custom: false
    };
    advanceQuestionCursor(state);
}

/* 追加/更新补充说明：只写 supplement，绝不触碰已点选的选项。
   也不推进光标——补充是对当前题的注解，不是「这题答完了」的信号，
   推进会让用户补一句话就被翻到下一题。 */
function applyQuestionSupplement(state, index, text) {
    if (!state) return;
    var sup = (text == null) ? '' : String(text).trim();
    var prev = questionAnswerFor(state, index);
    var sel = (prev && prev.selectedLabel) ? String(prev.selectedLabel) : '';
    state.drafts[index] = sup;
    if (!sup && !sel) {
        // 既没选项也没补充：撤掉这道题的答案，回到未作答态（允许用户反悔清空）
        delete state.answers[index];
        return;
    }
    state.answers[index] = {
        index: index,
        text: composeQuestionAnswerText(sel, sup),
        selectedLabel: sel,
        supplement: sup,
        skipped: false,
        // 没点任何选项、纯手写 = 用户自定义回答；已点选项则 custom 保持 false
        custom: !sel && !!sup
    };
}

/* 手写文本统一入口（卡片内补充行 Enter 与底部主输入框共用）：
   当前题已点选选项 → 作为补充追加，选项保留（这是本次修复的核心：
   旧实现无条件整条覆盖 answers[index]，用户选完选项再补一句，选项会被静默顶掉，
   后端只看到 custom=true 的补充文本，模型完全不知道用户选过什么）；
   当前题未点选 → 作为自定义答案替代（原语义不变）。 */
function applyQuestionCustomAnswer(state, index, text) {
    if (!state) return;
    var prev = questionAnswerFor(state, index);
    if (prev && !prev.skipped && prev.selectedLabel) {
        applyQuestionSupplement(state, index, text);
        return;
    }
    var val = (text == null) ? '' : String(text);
    state.answers[index] = {
        index: index, text: val, selectedLabel: '', supplement: '', skipped: false, custom: true
    };
    state.drafts[index] = val;
    advanceQuestionCursor(state);
}

function skipQuestionAnswer(state) {
    if (!state || !state.questions || state.questions.length === 0) return;
    var i = state.current;
    // 已有状态（已答/已跳过）的题只推进，不覆盖
    if (!state.answers[i]) state.answers[i] = skippedAnswer(i);
    advanceQuestionCursor(state);
}

function skippedAnswer(index) {
    return { index: index, text: '', selectedLabel: '', supplement: '', skipped: true, custom: false };
}

function fillUnansweredAsSkipped(state) {
    if (!state || !state.questions) return;
    for (var i = 0; i < state.questions.length; i++) {
        if (!state.answers[i]) state.answers[i] = skippedAnswer(i);
    }
}

/* 出站 payload 严格保持四键 {index,text,skipped,custom}：
   selectedLabel / supplement 只是本地渲染与「不覆盖」判定用的语义位，绝不入表——
   后端 AskUser.parseAnswers / formatAnswerText 与两份契约测试都按这四个字段冻结。 */
function buildQuestionAnswersPayload(state) {
    var out = [];
    var n = (state && state.questions) ? state.questions.length : 0;
    for (var i = 0; i < n; i++) {
        var a = (state && state.answers && state.answers[i]) || null;
        if (!a) a = skippedAnswer(i);
        out.push({
            index: i,
            text: (a.text == null) ? '' : String(a.text),
            skipped: !!a.skipped,
            custom: !!a.custom
        });
    }
    return { answers: out };
}

/* 把一条答案整形为「内容区问答记录」的展示视图（纯函数）。
   答案 text 可能是：① 点选选项 → 原始 label（可能拼了「（补充：…）」）；② 自定义 → 用户手写文本。
   记录要可读，故对 ① 反查选项、用 questionOptionView 的短标题+说明呈现，并把补充单独拎出来；
   ② 原样呈现。反查不到（旧数据/文本被改）时退回原文，绝不丢信息。 */
function formatQuestionAnswerForRecord(question, answerItem) {
    var a = answerItem || {};
    var text = (a.text == null) ? '' : String(a.text);
    if (a.skipped || !text.trim()) {
        return { skipped: true, title: '', desc: '', supplement: '', custom: false };
    }
    var opts = (question && question.options) || [];
    var supPrefix = '（补充：';
    for (var i = 0; i < opts.length; i++) {
        var label = (opts[i].label == null) ? '' : String(opts[i].label);
        if (!label) continue;
        var supplement = '';
        if (text === label) {
            supplement = '';
        } else if (text.indexOf(label + supPrefix) === 0 && text.charAt(text.length - 1) === '）') {
            supplement = text.slice(label.length + supPrefix.length, -1);
        } else {
            continue;
        }
        var view = questionOptionView(opts[i]);
        return { skipped: false, title: view.title, desc: view.desc, supplement: supplement, custom: false };
    }
    // 自定义回答（或反查失败）：原样呈现
    return { skipped: false, title: text, desc: '', supplement: '', custom: true };
}

/* ---- 问答卡 DOM 渲染 ---- */
/* 卡片内联 SVG（currentColor 描边，禁止 layui 字体图标，见仓库图标硬约定） */
var QUESTION_CARD_SVG_PREV = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
var QUESTION_CARD_SVG_NEXT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
var QUESTION_CARD_SVG_CLOSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
var QUESTION_CARD_SVG_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>';
/* 下尖角：detail 展开/收起切换，展开态由 CSS 旋转 180° */
var QUESTION_CARD_SVG_CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
/* 内容区问答记录的图标：对话气泡 + 已确认对勾（表达「问答已闭环」，与 HITL 审批卡同层级）。
   线框风格与全局图标约定一致：24 网格、1.6~2px 描边、currentColor。 */
var QUESTION_RECORD_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/><polyline points="8.5 12.2 10.8 14.5 15.3 10"/></svg>';

/* 底部按钮三态 → 文案键。源头在 questionSubmitMode，渲染与点击共用。 */
var QUESTION_SUBMIT_MODE_KEYS = {
    skip: 'chat.question_skip',
    next: 'chat.question_next',
    submit: 'chat.question_submit'
};

/* 底部主输入框当前文本（仅活动会话）。输入框全局共享，非活动会话的卡不得读走别人正在打的字，
   与 harvestQuestionInputOnSubmit 的归属口径一致（否则按钮会显示「下一步」但收割时早退，文案与行为脱节）。 */
function currentInputBoxText(sess) {
    if (!sess || sess.sessionId !== activeSessionId) return '';
    if (typeof getInputText !== 'function') return '';
    try { return getInputText() || ''; } catch (e) { return ''; }
}

/* 轻量刷新底部按钮文案（不重建整卡）。
   主输入框的每次敲键都会调到这里；若走 syncQuestionCard 整卡重建，卡内补充框会被重建而
   丢焦点与光标（用户正在卡内打字时直接被打断），故只改按钮的 textContent 与 data-mode。 */
function refreshQuestionSubmitLabel() {
    var host = document.getElementById('questionCardHost');
    if (!host) return;
    var btn = host.querySelector('.question-card-submit');
    if (!btn) return;
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    var state = sess ? (sess._questionState || null) : null;
    if (!state || state.submitted) return;
    var mode = questionSubmitMode(state, currentInputBoxText(sess));
    if (btn.getAttribute('data-mode') === mode) return;
    btn.setAttribute('data-mode', mode);
    btn.textContent = GourdI18n.t(QUESTION_SUBMIT_MODE_KEYS[mode] || QUESTION_SUBMIT_MODE_KEYS.skip);
}
window.refreshQuestionSubmitLabel = refreshQuestionSubmitLabel;

/* 宿主容器：chat.html 已内建 #questionCardHost（.input-wrap 内、输入框上方）；
   本函数兜底自建（旧缓存页面）并保证委托事件只绑定一次。 */
function ensureQuestionCardHost() {
    var host = document.getElementById('questionCardHost');
    if (!host) {
        var wrap = document.querySelector('#chatView .input-wrap') || document.querySelector('.input-wrap');
        if (!wrap) return null;
        host = document.createElement('div');
        host.className = 'question-card-host';
        host.id = 'questionCardHost';
        host.style.display = 'none';
        var inputBox = wrap.querySelector('.input-box');
        if (inputBox) wrap.insertBefore(host, inputBox);
        else wrap.appendChild(host);
    }
    bindQuestionCardEvents(host);
    return host;
}

/* 宿主上的委托事件只绑定一次（卡片内容逐次重建，委托挂在宿主上不受重建影响） */
function bindQuestionCardEvents(host) {
    if (!host || host._questionCardBound) return;
    host._questionCardBound = true;

    // 选项行：记录该题答案并自动推进下一题
    $(host).on('click', '.question-card-option[data-opt-index]', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        var qi = parseInt($(this).attr('data-q-index'), 10);
        var oi = parseInt($(this).attr('data-opt-index'), 10);
        var q = st.questions[qi];
        var opt = q && q.options && q.options[oi];
        if (!opt) return;
        applyQuestionOptionAnswer(st, qi, opt.label);
        syncQuestionCard();
    });

    // detail 展开/收起：长补充说明默认收起（取证 p50=115 字），点「展开」看全文。
    // 只重建当前卡，展开态记在 state.detailOpen[idx]，不受整卡重建影响。
    $(host).on('click', '.question-card-detail-toggle', function() {
        var st = activeQuestionCardState();
        if (!st) return;
        var qi = parseInt($(this).attr('data-q-index'), 10);
        if (isNaN(qi)) return;
        st.detailOpen[qi] = !st.detailOpen[qi];
        syncQuestionCard();
    });

    // 「其他补充」输入：草稿实时写入状态（重建不丢字），并联动底部按钮文案
    //（打下第一个字就从「跳过」变成「下一步/发送」；只改按钮不重建卡，不打断输入）
    $(host).on('input', '.question-card-other-input', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        st.drafts[st.current] = this.value;
        refreshQuestionSubmitLabel();
    });

    // 「其他补充」输入：Enter 确认自定义答案并推进；Esc 收起输入
    $(host).on('keydown', '.question-card-other-input', function(e) {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            var val = (this.value || '').trim();
            if (!val) return;   // 空输入不产生自定义答案
            applyQuestionCustomAnswer(st, st.current, val);
            syncQuestionCard();
        } else if (e.key === 'Escape') {
            /* 输入框常驻后已无「收起」语义，Esc 改为失焦：让用户离开卡片内输入、
               回到主输入框或键盘导航，同时不必为此白白整卡重建一次。 */
            try { this.blur(); } catch (e2) {}
        }
    });

    // 翻页（仅多题时渲染）
    $(host).on('click', '.question-card-prev', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        if (st.current > 0) { st.current -= 1; syncQuestionCard(); }
    });
    $(host).on('click', '.question-card-next', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        if (st.current < st.questions.length - 1) { st.current += 1; syncQuestionCard(); }
    });

    // X：跳过剩余未答题并直接提交（防任务卡死）
    $(host).on('click', '.question-card-close', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        fillUnansweredAsSkipped(st);
        handleQuestionResponse(sessionMap[activeSessionId], st);
    });

    /* 底部按钮：严格按 questionSubmitMode 的实时结果执行，做到「看到什么就做什么」。
       这里实时重算而不读 data-mode：后者只是上一次渲染/刷新的快照，若刷新钩子未触发会与
       当下真实状态不符；宁可与文案差一拍，也不能按陈旧快照把用户刚打的字当成「跳过」丢掉。
       next：先把已打的字收割成本题答案（复用提交路径同一函数），再跳到下一道待办题；
       skip：本题确实无答案也无输入，记为跳过并推进（原语义）。 */
    $(host).on('click', '.question-card-submit', function() {
        var st = activeQuestionCardState();
        if (!st || st.submitted) return;
        var sess = sessionMap[activeSessionId];
        var mode = questionSubmitMode(st, currentInputBoxText(sess));
        if (mode === 'submit') {
            handleQuestionResponse(sess, st);
        } else if (mode === 'next') {
            harvestQuestionInputOnSubmit(sess, st);
            // 收割后本题已有答案，环绕找下一道真正待办的题（不能用 +1：末题会原地卡死）；
            // 极端情况下收割未产生答案（如纯空白输入）则退回原有递进，保证按钮总有反馈。
            var nextIdx = nextUnansweredQuestionIndex(st, st.current);
            if (nextIdx >= 0) st.current = nextIdx; else advanceQuestionCursor(st);
            syncQuestionCard();
        } else {
            skipQuestionAnswer(st);
            syncQuestionCard();
        }
    });
}

/* 当前活动会话的问答状态（DOM 事件入口统一从活动会话取，避免闭包持有已切走会话） */
function activeQuestionCardState() {
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    var st = (sess && sess._questionState) || null;
    if (!st || !st.questions || st.questions.length === 0) return null;
    return st;
}

/* 待作答状态：仅「存在题面且未提交」才算挂起（供 sendMessage 文本路由与卡片渲染共用） */
function getPendingQuestionState(sess) {
    var st = (sess && sess._questionState) || null;
    if (!st || st.submitted) return null;
    if (!st.questions || st.questions.length === 0) return null;
    return st;
}

/* question 帧入口（实时与历史回放共用）：状态挂会话；仅活动会话渲染 DOM。
   同 actionId 重复帧幂等（保留已作答进度，仅刷新题面）；不同 actionId 视为新一轮提问，替换旧状态。

   【回放隔离】回放期的历史 question 帧同样不得抢占当前活跃卡：用户正在作答 B 时上拉加载历史，
   历史里的问题 A 会先把状态改写成 A（随后的应答帧再把它清掉），结果同样是 B 的卡消失。
   故回放中遇到「已有未提交且 actionId 不同」的活跃状态时直接跳过；其余情形（无状态/同题/已提交）
   行为不变，初始加载时「切回会话重建待答卡」的回放路径照常生效。 */
function appendQuestionCard(sess, chunk) {
    if (!sess) return;
    var actionId = (chunk && chunk.actionId) ? String(chunk.actionId) : '';
    var prev = sess._questionState;
    if (sess._replaying && prev && !prev.submitted && prev.actionId !== actionId) return;
    if (!prev || prev.actionId !== actionId || prev.submitted) {
        sess._questionState = createQuestionCardState(actionId, normalizeQuestionArgs(chunk && chunk.args));
    } else {
        prev.questions = normalizeQuestionArgs(chunk && chunk.args);
        if (prev.current >= prev.questions.length) prev.current = Math.max(0, prev.questions.length - 1);
    }
    if (sess.sessionId === activeSessionId) syncQuestionCard();
}

/* 内容区问答记录：作答闭环后在对话流里落一条「问 + 答」记录。

   【为何必需】问答卡是悬浮在输入框上方的弹层，收到 question_answered 就整体消失——
   用户回看历史时根本看不出自己当时选了什么（取证：92 条 answered 帧全部只带 answers，
   题面不在帧里），模型后续引用「你选了方案 A」时用户无法对账。
   HITL 审批卡本来就留在消息流里，问答反而消失，两者语义不对等。

   【题面从哪来】question_answered 帧的 args 只有 answers（帧契约冻结），故题面取自
   先前 question 帧建立的 _questionState。回放时 appendQuestionCard 可能因隔离规则跳过
   （已有不同 actionId 的活跃卡），此时 state 与帧不同题——所以必须校验 actionId 一致
   才用其 questions；不一致则只渲染答案（宁可少题面，不可张冠李戴）。

   【幂等】按 actionId 去重：回放、他端作答、提交失败重试都可能重复触发同一帧。 */
function appendQuestionAnswerRecord(sess, state, chunk) {
    if (!sess) return;
    var answers = (chunk && chunk.args && chunk.args.answers) || null;
    if (!Array.isArray(answers) || answers.length === 0) return;

    var actionId = (chunk && chunk.actionId) ? String(chunk.actionId)
        : ((state && state.actionId) ? String(state.actionId) : '');
    var root = renderRoot(sess);
    if (!root) return;
    if (actionId && $(root).find('.qa-record[data-action-id="' + actionId.replace(/"/g, '\\"') + '"]').length) return;

    // 题面只在身份对得上时才可用（见上）
    var questions = (state && actionId && state.actionId === actionId) ? state.questions : null;

    ensureAssistantBubble(sess);
    var el = $('<div>').addClass('qa-record')[0];
    if (actionId) el.setAttribute('data-action-id', actionId);
    if (sess.currentRunId) el.setAttribute('data-run-id', sess.currentRunId);

    var html = '<div class="qa-record-head">'
        + '<span class="qa-record-icon">' + QUESTION_RECORD_SVG + '</span>'
        + '<span class="qa-record-label">' + escapeHtml(GourdI18n.t('chat.question_record_title')) + '</span>'
        + '</div>';
    html += '<div class="qa-record-items">';
    for (var i = 0; i < answers.length; i++) {
        var item = answers[i] || {};
        var idxNum = (item.index == null) ? i : Number(item.index);
        var q = (questions && questions[idxNum]) || null;
        var rec = formatQuestionAnswerForRecord(q, item);
        html += '<div class="qa-record-item">';
        if (q && q.header) html += '<div class="qa-record-q">' + escapeHtml(q.header) + '</div>';
        html += '<div class="qa-record-a' + (rec.skipped ? ' skipped' : '') + '">'
            + escapeHtml(rec.skipped ? GourdI18n.t('chat.question_skipped') : rec.title)
            + (rec.desc ? '<span class="qa-record-a-desc">' + escapeHtml(rec.desc) + '</span>' : '')
            + (rec.supplement ? '<span class="qa-record-a-sup">' + escapeHtml(rec.supplement) + '</span>' : '')
            + '</div>';
        html += '</div>';
    }
    html += '</div>';
    el.innerHTML = html;

    insertBeforeActions(sess, el);
    // 推进正文指针：记录之后的 AI 正文应落在它下方，不得回灌进上一个气泡
    advanceBodyPointer(sess, sess, function(freshMd) { insertBeforeActions(sess, freshMd); });
    if (sess.sessionId === activeSessionId && !isDetachedRenderTarget(sess)
            && document.contains(sess.container)) scrollToBottom(true);
}
window.appendQuestionAnswerRecord = appendQuestionAnswerRecord;

/* question_answered 帧入口：问答已闭环（本人提交或他端作答），落一条内容区记录后清状态并隐藏卡片。
   回放链路上「question 先建卡 → question_answered 随即隐藏」由顺序重放自然达成。

   【回放隔离】历史帧不得改写当前活跃会话的问答状态：用户正等待回答问题 B 时向上翻页，
   历史里问题 A 的 question_answered 会把 B 的卡直接清掉且回放结束后不恢复（卡永久消失）。
   按 actionId 区分而不是简单地「回放期一律不清」：同一道题的历史应答帧仍应收卡（他端已作答的真实闭环）。
   旧帧无 actionId（字段新增前落盘）：实时帧维持旧行为（无条件清），回放帧则不清——
   宁可多留一瞬已答卡，也好过把用户正在作答的当前卡弄没。 */
function handleQuestionAnsweredFrame(sess, chunk) {
    if (!sess) return;
    var st = sess._questionState;
    if (!st) return;
    var frameActionId = (chunk && chunk.actionId) ? String(chunk.actionId) : '';
    if (sess._replaying) {
        // 回放上下文：只允许清「同一道题」的卡；无法比对身份时一律不动当前状态。
        if (!frameActionId || !st.actionId || st.actionId !== frameActionId) return;
    } else if (frameActionId && st.actionId && st.actionId !== frameActionId) {
        // 实时帧也不得跨题清卡：另一道题的闭环帧与当前待答卡无关。
        return;
    }
    // 先落内容区记录再清状态：记录需要从 state 取题面（帧里没有）
    try { appendQuestionAnswerRecord(sess, st, chunk); } catch (e) { console.error('[question] 问答记录渲染失败', e); }
    sess._questionState = null;
    if (sess.sessionId === activeSessionId) syncQuestionCard();
}

/* 按当前活动会话的问答状态同步卡片：无状态 → 隐藏；有状态 → 按状态重建内容。
   调用点：帧到达、卡片交互、会话切换（setActiveSession/deactivateSession）、语言切换。 */
function syncQuestionCard() {
    /* 问答挂起标志（app-base.js applyChatPlaceholder 消费）：活动会话存在未提交待答题时，
       主输入框 placeholder 切换为「输入想法即作答」指引——挂起期打字会被记为当前题答案，
       但入口零提示用户根本不知道这条路。host 缺失等异常路径不影响标志结算，故先于 host 取值。 */
    var sess = activeSessionId ? sessionMap[activeSessionId] : null;
    var pendingHint = !!getPendingQuestionState(sess);
    if (window._questionPendingHint !== pendingHint) {
        window._questionPendingHint = pendingHint;
        if (typeof applyChatPlaceholder === 'function') applyChatPlaceholder();
    }
    var host = ensureQuestionCardHost();
    if (!host) return;
    var state = sess ? (sess._questionState || null) : null;
    if (!state || !state.questions || state.questions.length === 0) {
        host.innerHTML = '';
        $(host).hide();
        return;
    }
    renderQuestionCard(host, sess, state);
    $(host).show();
}

/* 属性上下文转义：全局 escapeHtml 只覆盖 &<>，属性值里的引号会截断属性（自注入面）。
   与 app-model-settings.js 的 escapeAttr 同口径。 */
var escapeAttr = function (s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
};

/* 渲染卡片到宿主（整卡重建；交互态与输入草稿全部来自 state，重建无损） */
function renderQuestionCard(host, sess, state) {
    var n = state.questions.length;
    var submitted = !!state.submitted;
    if (!n) { host.innerHTML = ''; $(host).hide(); return; }
    var idx = Math.min(Math.max(state.current || 0, 0), n - 1);
    state.current = idx;
    var q = state.questions[idx] || { header: '', detail: '', options: [] };
    var answer = questionAnswerFor(state, idx);

    /* 入场动画只在首次渲染播放（.question-card-enter）：勾选/翻页等交互会整卡重建，
       若动画挂在 .question-card 上会随每次重建重放，整卡闪一下（msg-in 的透明度/位移过渡）。 */
    var entering = state._entered ? '' : ' question-card-enter';
    state._entered = true;

    var html = '<div class="question-card' + (submitted ? ' submitted' : '') + entering + '" data-action-id="' + escapeAttr(state.actionId || '') + '">';

    /* 题目行：题目文本（含可折叠详情/跳过标记）｜右侧 ‹ n/N ›（仅多题）与 X。
       detail 取证中位 115 字、p90 280：超阈值默认收起为两行（CSS 限高），「展开」按钮切换；
       展开态记在 state.detailOpen[idx]，整卡重建（勾选/翻页）不丢。 */
    html += '<div class="question-card-header">';
    html += '<div class="question-card-heading">';
    html += '<span class="question-card-title">' + escapeHtml(q.header || '') + '</span>';
    if (answer && answer.skipped) {
        html += '<span class="question-card-skip-tag">' + escapeHtml(GourdI18n.t('chat.question_skipped')) + '</span>';
    }
    html += '</div>';
    if (n > 1) {
        html += '<div class="question-card-nav">'
            + '<button type="button" class="question-card-nav-btn question-card-prev"' + (idx <= 0 || submitted ? ' disabled' : '') + '>' + QUESTION_CARD_SVG_PREV + '</button>'
            + '<span class="question-card-nav-count">' + (idx + 1) + '/' + n + '</span>'
            + '<button type="button" class="question-card-nav-btn question-card-next"' + (idx >= n - 1 || submitted ? ' disabled' : '') + '>' + QUESTION_CARD_SVG_NEXT + '</button>'
            + '</div>';
    }
    if (!submitted) {
        html += '<button type="button" class="question-card-close" data-i18n-title="chat.question_close" title="' + escapeAttr(GourdI18n.t('chat.question_close')) + '">' + QUESTION_CARD_SVG_CLOSE + '</button>';
    } else {
        html += '<span class="question-card-close-placeholder" aria-hidden="true"></span>';
    }
    html += '</div>';

    if (q.detail) {
        var collapsible = questionDetailShouldCollapse(q.detail);
        var detailOpen = !!state.detailOpen[idx];
        html += '<div class="question-card-detail' + ((collapsible && !detailOpen) ? ' collapsed' : '') + '">' + escapeHtml(q.detail) + '</div>';
        if (collapsible) {
            html += '<button type="button" class="question-card-detail-toggle" data-q-index="' + idx + '" aria-expanded="' + (detailOpen ? 'true' : 'false') + '">'
                + escapeHtml(GourdI18n.t(detailOpen ? 'chat.question_detail_collapse' : 'chat.question_detail_expand'))
                + QUESTION_CARD_SVG_CHEVRON + '</button>';
        }
    }

    /* 选项区：单行可扫读形态 —— 序号徽章 + 粗体短标题 + 推荐胶囊 + 灰色说明。
       整形只影响展示（questionOptionView）：选中判定与出站答案仍用原始 label，
       答案协议零改动。选项多时由 CSS 限高滚动，不把输入框顶出屏幕。 */
    html += '<div class="question-card-options">';
    var optList = q.options || [];
    for (var oi = 0; oi < optList.length; oi++) {
        var o = optList[oi] || {};
        var view = questionOptionView(o);
        var selected = questionOptionSelected(state, idx, view.label);
        html += '<button type="button" class="question-card-option' + (selected ? ' selected' : '') + '"'
            + (submitted ? ' disabled' : '')
            + ' data-q-index="' + idx + '" data-opt-index="' + oi + '">'
            + '<span class="question-card-opt-index">' + (oi + 1) + '</span>'
            + '<span class="question-card-opt-main">'
            + '<span class="question-card-opt-title">' + escapeHtml(view.title)
            + (o.recommended ? '<span class="question-card-opt-reco">' + escapeHtml(GourdI18n.t('chat.question_recommended')) + '</span>' : '')
            + '</span>'
            + (view.desc ? '<span class="question-card-opt-desc">' + escapeHtml(view.desc) + '</span>' : '')
            + '</span>'
            + '</button>';
    }
    /* 常驻输入框：总是以编辑态呈现（旧版「点击才变输入框」多一步操作且入口不显眼，
       取证显示用户经常选完选项还想补一句）。placeholder 随本题状态切换：
       已点选选项时是「补充说明」（与选项一起提交），未点选时是「自己输入回答」（替代选项）。
       提交后转为只读展示行（已入库的补充文本）。 */
    var selLabel = (answer && answer.selectedLabel) ? String(answer.selectedLabel) : '';
    var hasSel = !!selLabel;
    var supText = (answer && !answer.skipped)
        ? String(answer.supplement || (answer.custom ? (answer.text || '') : '') || '')
        : '';
    var draft = (state.drafts[idx] != null)
        ? String(state.drafts[idx])
        : supText;
    if (!submitted) {
        html += '<div class="question-card-other-row is-editing">'
            + '<span class="question-card-opt-index">' + QUESTION_CARD_SVG_EDIT + '</span>'
            + '<input type="text" class="question-card-other-input" autocomplete="off" spellcheck="false" placeholder="' + escapeAttr(hasSel ? GourdI18n.t('chat.question_supplement_placeholder') : GourdI18n.t('chat.question_other_placeholder')) + '" value="' + escapeAttr(draft) + '"/>'
            + '</div>';
    } else if (supText) {
        html += '<div class="question-card-other-row selected" data-q-index="' + idx + '">'
            + '<span class="question-card-opt-index">' + QUESTION_CARD_SVG_EDIT + '</span>'
            + '<span class="question-card-opt-label">' + escapeHtml(GourdI18n.t('chat.question_supplement')) + '</span>'
            + '<span class="question-card-opt-answer">' + escapeHtml(supText) + '</span>'
            + '</div>';
    }
    html += '</div>';

    /* 底部行：左状态（等待您的回答… / 已提交），右按钮（跳过 / 下一步 / 发送）。
       按钮文案与 data-mode 同时由 questionSubmitMode 决定，点击处理器直接读 data-mode，
       保证「看到什么就执行什么」——不会出现写着「跳过」却在翻页、或写着「跳过」却丢字。 */
    html += '<div class="question-card-footer">';
    html += '<span class="question-card-status">'
        + escapeHtml(GourdI18n.t(submitted ? 'chat.question_answered' : 'chat.question_waiting'))
        + '</span>';
    if (!submitted) {
        var mode = questionSubmitMode(state, currentInputBoxText(sess));
        html += '<button type="button" class="question-card-submit" data-mode="' + escapeAttr(mode) + '">'
            + escapeHtml(GourdI18n.t(QUESTION_SUBMIT_MODE_KEYS[mode] || QUESTION_SUBMIT_MODE_KEYS.skip))
            + '</button>';
    }
    html += '</div>';

    html += '</div>';
    /* 重建前先取现场：整卡是 innerHTML 全量重建，聚焦元素与滚动位置都会随之销毁。
       「输入框常驻化」后这是真实回归——旧版靠 focusOther 显式补焦，但其唯一调用方
       （点击入口行才渲染 input 的那条路径）已被本次改造删除，于是敲 Enter 提交补充、
       或点选任一选项后，焦点掉回 body：用户既不能接着打字，也失去了键盘导航能力。 */
    var focusKey = questionCardFocusKeyIn(host);
    var caret = questionCardCaretIn(host);
    var scroll = questionCardScrollSnapshot(host);

    host.innerHTML = html;

    questionCardRestoreView(host, focusKey, caret, scroll);
}

/* 焦点元素的稳定标识 = 标签名 + 非状态类名 + 全部 data-* 属性。
   刻意排除 selected / is-editing / collapsed 等状态类：点选选项后该类会被加上，
   若算进 key 就永远匹配不上，焦点恢复恰好在其最该生效的场景失效。
   用属性而非「第几个子元素」定位：detail 折叠/选项增减都不影响匹配。 */
var QUESTION_CARD_VOLATILE_CLASS = { selected: 1, 'is-editing': 1, collapsed: 1, disabled: 1, 'question-card-enter': 1 };

function questionCardFocusKeyOf(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [el.tagName];
    var cls = (typeof el.className === 'string') ? el.className.trim().split(/\s+/) : [];
    for (var i = 0; i < cls.length; i++) {
        if (cls[i] && !QUESTION_CARD_VOLATILE_CLASS[cls[i]]) parts.push('.' + cls[i]);
    }
    var attrs = el.attributes || [];
    for (var j = 0; j < attrs.length; j++) {
        if (attrs[j].name.indexOf('data-') === 0) parts.push('[' + attrs[j].name + '="' + attrs[j].value + '"]');
    }
    return parts.join('');
}

/* 当前聚焦元素的 key（不在卡内则返回空，表示无需恢复） */
function questionCardFocusKeyIn(host) {
    if (!host || typeof document === 'undefined') return '';
    var el = document.activeElement;
    if (!el || el === document.body || !host.contains(el)) return '';
    return questionCardFocusKeyOf(el);
}

/* 光标区间：只有文本输入才有意义；部分 input 类型读 selectionStart 会抛错，整体兜底。 */
function questionCardCaretIn(host) {
    if (!host || typeof document === 'undefined') return null;
    var el = document.activeElement;
    if (!el || el === document.body || !host.contains(el)) return null;
    if (typeof el.selectionStart !== 'number') return null;
    try { return { start: el.selectionStart, end: el.selectionEnd }; } catch (e) { return null; }
}

/* 滚动现场：整卡与选项区都是限高滚动容器。用户滚到第 5 个长选项时点选，重建会把
   滚动条弹回顶部——焦点恢复只能救回焦点元素本身，救不回用户主动滚出的视野。 */
function questionCardScrollSnapshot(host) {
    if (!host) return null;
    var card = host.querySelector('.question-card');
    var list = host.querySelector('.question-card-options');
    return { card: card ? card.scrollTop : 0, list: list ? list.scrollTop : 0 };
}

/* 重建后还原视野：焦点 → 光标 → 滚动。顺序有意为之——focus() 自带滚动副作用，
   故滚动放在最后，让用户重建前看到的位置最终生效。 */
function questionCardRestoreView(host, key, caret, scroll) {
    if (!host) return;
    if (key) {
        var cands = host.querySelectorAll('input, textarea, button, [tabindex]');
        for (var i = 0; i < cands.length; i++) {
            if (questionCardFocusKeyOf(cands[i]) !== key) continue;
            try {
                cands[i].focus();
                if (caret && typeof cands[i].selectionStart === 'number') {
                    var max = (cands[i].value || '').length;
                    cands[i].setSelectionRange(Math.min(caret.start, max), Math.min(caret.end, max));
                }
            } catch (e2) {}
            break;
        }
    }
    if (!scroll) return;
    var card = host.querySelector('.question-card');
    var list = host.querySelector('.question-card-options');
    if (card && scroll.card) card.scrollTop = scroll.card;
    if (list && scroll.list) list.scrollTop = scroll.list;
}

/* 提交全部答案（镜像 handleHitlResponse 的本地状态处理：进入流式态 → POST → 失败回退）。
   payload：questionAnswer=JSON.stringify({answers:[{index,text,skipped,custom},...]})，恢复内容走 WebSocket。 */
function handleQuestionResponse(sess, state) {
    if (!sess || !state || state.submitted) return;
    // 先把「已打字但未回车」的卡片草稿与底部输入框文本收进答案，再置提交锁
    //（否则收割函数会被 submitted / getPendingQuestionState 拦住）
    harvestQuestionInputOnSubmit(sess, state);
    state.submitted = true;
    if (sess.sessionId === activeSessionId) syncQuestionCard();

    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }
    resetStreamState(sess);

    sess.isStreaming = true;
    if (sess.sessionId === activeSessionId) {
        isStreaming = true;
        setBtnStopMode();
    }
    showThinking(sess);

    // 通过统一提交入口发送全部答案，结果通过 WebSocket 推送。
    // 不带 input 键：后端靠它的存在性区分「新一轮」与「续轮」。
    var fields = {
        questionAnswer: JSON.stringify(buildQuestionAnswersPayload(state))
    };
    // 携带本张卡所属的调用标识：后端只按 sessionId 取待处理任务，旧页面/旧卡的迟到提交
    // 会把答案写到【另一道题】上。空值不入表（旧快照恢复的挂起任务可能本就没有 actionId）。
    if (state.actionId) fields.actionId = String(state.actionId);
    postChatInput(sess, fields, null, {
        onFail: function(err) {
            console.error('Question answer error:', err);
            // 失败回退：解除「已提交」锁，保留答案允许重试（否则卡片永卡禁用态而任务不会恢复）
            state.submitted = false;
            if (sess.sessionId === activeSessionId) syncQuestionCard();
            // 通过回调占位调用 finishStream（由 app-streaming.js 注册）——与 handleHitlResponse 同构
            if (onFinishStream) onFinishStream(sess);
        }
    });
}

/* 底部输入框路由入口：把待作答会话的输入文本记为当前题的自定义答案
   （语义等价卡片内「其他补充」输入 + Enter；由 sendMessage 在普通发送链路之前调用）。
   已点选选项时由 applyQuestionCustomAnswer 内部转为「追加补充」，选项不会被顶掉。 */
function applyQuestionCustomAnswerByText(sess, text) {
    var state = getPendingQuestionState(sess);
    if (!state) return false;
    var val = (text == null ? '' : String(text)).trim();
    if (!val) return false;
    applyQuestionCustomAnswer(state, state.current, val);
    clearInput();
    if (sess.sessionId === activeSessionId) syncQuestionCard();
    return true;
}

/* 提交前收割「用户已经打了但没回车」的两处文字，全部折进当前题答案。

   【为什么必须有这一步】两个真实丢字路径：
   ① 卡片内补充行打了字但直接去点「发送」（没按 Enter）—— 草稿只在 drafts 里，不入 answers；
   ② 选完选项后在底部主输入框补一句，然后点卡片「发送」—— 这条路径不经 sendMessage，
      文字既不在 answers 里也没被清空，静静留在输入框（看起来像发出去了），模型完全收不到。
   这正是「选了选项，下面输入的内容没携带给模型」的根因。

   两处同时存在时合并为一段（卡片草稿优先，再接输入框文本），不互相覆盖。
   只收当前活动会话的输入框（输入框全局共享，卡片属于 sess）；附件不在收割范围内
   （答案协议只有 text 字段），保持原有暂存不动——附件留在输入框里，用户随后按 Enter
   会由 sendMessage 的问答分支落盘并排入队列（见 queueQuestionAttachments），不会丢。
   光标位置收割后还原：提交失败回退（submitted=false）时不给重试引入额外差异。 */
function harvestQuestionInputOnSubmit(sess, state) {
    if (!sess || !state || sess.sessionId !== activeSessionId) return;

    var idx = state.current;
    var applied = questionAnswerFor(state, idx);
    // 当前题已被标记跳过（如点 X「跳过剩余直接提交」先走 fillUnansweredAsSkipped）：
    // 尊重用户的放弃意图，输入框残留不得把一道已跳过的题偷偷改成自定义答案。
    if (applied && applied.skipped) return;
    var appliedSup = (applied && applied.supplement) ? String(applied.supplement).trim() : '';

    /* ① 卡片内补充行的未确认草稿：它是该字段的编辑缓冲（input 事件实时回写），
          比已入库值更新，故直接取代——不得拼接，否则同一段话会写两遍。 */
    var sup = appliedSup;
    if (state.drafts && Object.prototype.hasOwnProperty.call(state.drafts, idx)) {
        var draft = String(state.drafts[idx] == null ? '' : state.drafts[idx]).trim();
        if (draft) sup = draft;
    }

    /* ② 底部主输入框的文本：它是【另一个输入面】，追加到补充末尾（不覆盖已确认的） */
    var boxText = (typeof getInputText === 'function') ? (getInputText() || '').trim() : '';
    if (boxText) sup = sup ? (sup + ' ' + boxText) : boxText;

    if (!sup || sup === appliedSup) return;   // 无新内容，不动答案

    var savedCursor = state.current;
    // 统一走 applyQuestionSupplement：已点选项→追加为补充（选项保留），未点选项→记为自定义回答
    applyQuestionSupplement(state, idx, sup);
    state.current = savedCursor;
    if (boxText && typeof clearInput === 'function') clearInput();
}

/* ===== Rewind Handling ===== */
function handleRewind(sess, count) {
    if (count <= 0) return;
    // count = 要删除的消息条数，从末尾倒序删除
    var toRemove = count;
    var rows = $(renderRoot(sess)).find('.msg-row');
    var actual = Math.min(toRemove, rows.length);
    for (var i = 0; i < actual; i++) {
        $(rows[rows.length - 1]).remove();
        rows = $(renderRoot(sess)).find('.msg-row');
    }
    resetStreamState(sess);
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}

/* ===== Code Block Copy Buttons ===== */
function addCodeBlockButtons(container) {
    if (!container) return;
    var pres = $(container).find('pre');
    for (var i = 0; i < pres.length; i++) {
        if ($(pres[i]).find('.code-copy-btn').length) continue;
        var btn = $('<button>').addClass('code-copy-btn').text(GourdI18n.t('chat.copy'))[0];
        $(btn).on('click', function(e) {
            e.stopPropagation();
            var pre = $(this).closest('pre')[0];
            var code = pre ? $(pre).find('code')[0] : null;
            var text = code ? $(code).text() : (pre ? $(pre).text() : '');
            var self = this;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(function() {
                    $(self).text(GourdI18n.t('chat.copy_success')).addClass('copied');
                    setTimeout(function() {
                        $(self).text(GourdI18n.t('chat.copy')).removeClass('copied');
                    }, 1500);
                });
            }
        });
        $(pres[i]).append(btn);
    }
}

/* ===== Image Lightbox ===== */
/* 附件图片挂在 .user-attach-imgs 下（气泡直接子节点），正文图片在 .md-content 下，两者都要可点开 */
function addImageLightbox(container) {
    if (!container) return;
    var imgs = $(container).find('.user-attach-imgs img, .md-content img');
    for (var i = 0; i < imgs.length; i++) {
        if ($(imgs[i]).data('lightbox')) continue;
        $(imgs[i]).data('lightbox', '1');
        imgs[i].style.cursor = 'zoom-in';
        $(imgs[i]).on('click', function(e) {
            e.stopPropagation();
            openLightbox(this.src);
        });
    }
}
window.addImageLightbox = addImageLightbox;

function openLightbox(src) {
    var overlay = $('<div>').addClass('lightbox-overlay')[0];
    var img = $('<img>').attr('src', src)[0];
    $(overlay).append(img);
    // 点遮罩与 Esc 两条关闭路径共用 close，避免点遮罩关闭后 keydown 监听残留累积
    function onKey(e) {
        if (e.key === 'Escape') close();
    }
    function close() {
        $(overlay).remove();
        $(document).off('keydown', onKey);
    }
    $(overlay).on('click', close);
    $(document).on('keydown', onKey);
    $(document.body).append(overlay);
}
window.openLightbox = openLightbox;

/* ===== 动态标签的语言切换重译 =====
   工具卡/思考块/批量分组/HITL 等在流式渲染时把译文写死进 DOM 文本节点，不带 data-i18n，
   translateDOM 扫不到；语言切换时按渲染阶段存下的原始数据（工具名/状态/耗时）用新语言重建。
   .agent-label、HITL 审批按钮为纯 key 独占元素，已加 data-i18n 交由 translateDOM 处理，此处不含。 */
function tagToolName(el, presentation) {
    if (!el || !presentation) return;
    el.setAttribute('data-i18n-tool', presentation.bareToolName || 'tool');
    if (presentation.toolTitle) el.setAttribute('data-i18n-tooltitle', presentation.toolTitle);
    else el.removeAttribute('data-i18n-tooltitle');
    el.setAttribute('data-i18n-tool-nested', presentation.nested ? '1' : '0');
    if (presentation.source) el.setAttribute('data-tool-source', presentation.source);
    else el.removeAttribute('data-tool-source');
    if (presentation.agentName) el.setAttribute('data-tool-agent', presentation.agentName);
    else el.removeAttribute('data-tool-agent');
}
window.tagToolName = tagToolName;

function relocalizeDynamicLabels() {
    if (!window.GourdI18n) return;
    document.querySelectorAll('.tool-name[data-i18n-tool]').forEach(function(el) {
        var presentation = resolveToolPresentation(
            el.getAttribute('data-i18n-tool'),
            el.getAttribute('data-i18n-tooltitle') || null,
            {
                nested: el.getAttribute('data-i18n-tool-nested') === '1',
                agentName: el.getAttribute('data-tool-agent') || null
            }
        );
        el.textContent = presentation.displayName;
    });
    document.querySelectorAll('.tool-name[data-i18n-hitl]').forEach(function(el) {
        var hitlTool = el.getAttribute('data-i18n-hitl-tool') || 'unknown';
        var hitlPresentation = resolveToolPresentation(hitlTool, null);
        el.textContent = GourdI18n.t('chat.' + el.getAttribute('data-i18n-hitl')) + hitlPresentation.displayName;
    });
    document.querySelectorAll('.tool-batch-title[data-i18n-batch-tool]').forEach(function(el) {
        var tn = el.getAttribute('data-i18n-batch-tool');
        var c = el.getAttribute('data-i18n-batch-count') || '0';
        el.textContent = batchTitleText(tn || null, c);
    });
    document.querySelectorAll('.tool-args-progress[data-args-bytes]').forEach(function(el) {
        // 骨架卡进度文案（「生成参数中 · 1.2 KB」）同样是流式写死进 DOM 的译文；
        // 字节数存在 data-args-bytes 里，切语言时用新语言重建，否则整条漏译。
        el.textContent = GourdI18n.t('chat.args_streaming', { size: formatArgsBytes(el.getAttribute('data-args-bytes')) });
    });
    document.querySelectorAll('.thinking-block-label[data-i18n-thinking]').forEach(function(el) {
        var st = el.getAttribute('data-i18n-thinking');
        var suffix = el.getAttribute('data-i18n-elapsed') || '';
        el.textContent = GourdI18n.t(st === 'finished' ? 'chat.thinking_finished' : 'chat.thinking_in_progress') + suffix;
    });
    // 结构化问答卡：题面计数（n/N）、推荐后缀、按钮等组合文案在渲染期以当时语言写死，
    // 语言切换时按已存状态整卡重建（drafts 实时同步，输入不受损）。
    if (typeof syncQuestionCard === 'function') syncQuestionCard();
}
window.relocalizeDynamicLabels = relocalizeDynamicLabels;
document.addEventListener('i18n:localeChanged', relocalizeDynamicLabels);
