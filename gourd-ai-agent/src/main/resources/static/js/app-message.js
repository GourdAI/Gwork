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

/* ===== Message Rendering (Session-Aware) ===== */
function appendUserMessage(sess, text, imageDataUrls, fileAttachments, createdAt) {
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
            tag.innerHTML = '<span>📎</span>'
                + '<span class="user-attach-file-name">' + escapeHtml(fileAttachments[j].name) + '</span>'
                + '<span class="user-attach-file-size">(' + formatFileSize(fileAttachments[j].size) + ')</span>';
            $(bubble).append(tag);
        }
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
    $(sess.container).append(row);
    // 容器不在 DOM 树中（如 loadMessages 的临时容器阶段）时跳过滚动，避免无效回流
    if (sess.sessionId === activeSessionId && document.contains(sess.container)) scrollToBottom(true);
}

function appendSystemNotice(sess, text) {
    var row = $('<div>').addClass('msg-row system-notice')[0];
    row.innerHTML = '<div class="system-notice-bubble">' + escapeHtml(text) + '</div>';
    $(sess.container).append(row);
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}

function appendSteerNote(sess, item) {
    if (!sess || !item || !item.steerId) return;
    if ($(sess.container).find('[data-steer-id="' + item.steerId + '"]').length) return;

    finishThinkingBlock(sess);
    ensureAssistantBubble(sess);

    var note = $('<div>').addClass('steer-note')[0];
    note.setAttribute('data-steer-id', item.steerId);
    if (item.runId || sess.activeRunId) note.setAttribute('data-run-id', item.runId || sess.activeRunId);
    note.innerHTML = '<span class="steer-note-badge">' + escapeHtml(GourdI18n.t('streaming.steer_tag')) + '</span>'
        + '<span class="steer-note-text"></span>';
    $(note).find('.steer-note-text').text(item.text || '');
    insertBeforeActions(sess, note);

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
        $(sess.container).append(row);
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
        + '<span class="tool-type-icon">🧠</span>'
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
   否则新内容会隐在卡体视口下方（用户看不到正在输出什么）。用户在卡内主动向上翻看时停止跟随。 */
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
        if (sess.sessionId === activeSessionId) {
            if (!userScrolledUp && messagesWrap) {
                // 同步赋值减少跳帧
                messagesWrap.scrollTop = messagesWrap.scrollHeight;
            }
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
            if (!userScrolledUp && messagesWrap && !sess._skipScroll) {
                // 直接用同步赋值减少跳帧；scrollToBottom 的 rAF 在这里已经太晚
                messagesWrap.scrollTop = messagesWrap.scrollHeight;
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
/* 左侧工具类型图标（emoji，按工具名映射） */
function toolTypeIcon(name) {
    var map = { edit: '\u270f\ufe0f', write: '\ud83d\udcdd', read: '\ud83d\udcd6', grep: '\ud83d\udd0d', glob: '\ud83d\udcc1', ls: '\ud83d\udcc1', bash: '\u26a1', bash_output: '\ud83d\udcca', todowrite: '\u2705', todoread: '\u2705', websearch: '\ud83c\udf10', webfetch: '\ud83d\udd17', codesearch: '\ud83d\udd0e', skill: '\ud83e\udde9', task: '\ud83e\udd16', multitask: '\ud83e\udd16', generate: '\u2728' };
    return map[name] || '\ud83d\udd27';
}

/* 工具名本地化映射：后端裸工具名 → i18n key。
   未列出的工具（如 MCP / OpenAPI 动态工具）回退原样显示。 */
var TOOL_I18N_KEY = {
    read: 'chat.tool_read', write: 'chat.tool_write', edit: 'chat.tool_edit',
    glob: 'chat.tool_glob', grep: 'chat.tool_grep', ls: 'chat.tool_ls',
    bash: 'chat.tool_bash', bash_output: 'chat.tool_bash_output',
    skill: 'chat.tool_skill',
    todo: 'chat.tool_todo', todowrite: 'chat.tool_todo', todoread: 'chat.tool_todo',
    code: 'chat.tool_code', codesearch: 'chat.tool_codesearch',
    websearch: 'chat.tool_websearch', webfetch: 'chat.tool_webfetch',
    task: 'chat.tool_task', multitask: 'chat.tool_multitask', generate: 'chat.tool_generate',
    mcp: 'chat.tool_mcp', openapi: 'chat.tool_openapi', lsp: 'chat.tool_lsp', memory: 'chat.tool_memory'
};
/* 将工具名本地化用于展示。toolTitle 可能形如 "agentName/toolName"（子代理内部调用），
   拆出前缀单独保留、仅翻译工具名部分；主代理时 toolTitle===toolName。未知工具回退原样。 */
function localizeToolName(toolName, toolTitle) {
    var prefix = '';
    var base = toolTitle || toolName || 'tool';
    if (toolName) {
        var sep = base.lastIndexOf('/' + toolName);
        if (sep >= 0 && base.slice(sep + 1) === toolName) {
            prefix = base.slice(0, sep + 1);  // 含末尾 '/'
            base = toolName;
        }
    }
    var key = TOOL_I18N_KEY[base];
    return prefix + (key && window.GourdI18n ? GourdI18n.t(key) : base);
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
function setToolCardStatus(cardEl, text) {
    var icon = $(cardEl).find('.tool-status-icon').first()[0];
    if (!icon) return;

    var isError = typeof text === 'string' && text.startsWith('__ERROR__');

    setTimeout(function() {
        requestAnimationFrame(function() {
            if (icon) {
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

/* 工具失败时把当前正在执行（loading）的卡片状态点置为红点。
   后端失败走 error 独立通道，不会发 action_end，故卡片会残留在 loading；
   若不处理，finishStream 会将其强刷为绿点（误报成功）。此处改赋红点。 */
function markToolCardFailed(sess) {
    var icons = [];
    if (sess.pendingToolCard) {
        var pi = $(sess.pendingToolCard).find('.tool-status-icon').first()[0];
        if (pi) icons.push(pi);
    }
    // 并行批量 / id 模式下无 pendingToolCard，兑掉容器内所有残留 loading 的卡片
    if (!icons.length && sess.container) {
        $(sess.container).find('.tool-status-icon.loading').each(function() { icons.push(this); });
    }
    icons.forEach(function(icon) { icon.className = 'tool-status-icon reject'; icon.innerHTML = ''; });
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

/* 抽取：把 args 对象格式化为短字符串（供卡片头部 tool-args 展示）。
   与 appendActionEndChunk 内的实现保持一致，供 action_start 复用。 */
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
    if (agentName && sess.agentCards && sess.agentCards[agentName + ':' + agentDesc] && sess.agentStates) {
        return sess.agentStates[agentName + ':' + agentDesc] || null;
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

/* 根据 action_start/action_end 共享的批量元数据建组并插入卡片。缺少 index 时按当前空槽顺序兜底。 */
function appendCardToBatch(sess, card, batchMeta, insertAgentBody) {
    var meta = normalizeBatchMeta(batchMeta);
    if (!meta) return false;
    if (!sess.toolBatchesById) sess.toolBatchesById = {};
    var batchKey = (sess.currentRunId || '') + '|' + meta.batchId;
    var batch = sess.toolBatchesById[batchKey];
    if (!batch || !document.contains(batch.groupEl)) {
        var group = $('<div>').addClass('tool-batch-group')[0];
        if (sess.currentRunId) group.setAttribute('data-run-id', sess.currentRunId);
        group.setAttribute('data-batch-id', meta.batchId);
        group.innerHTML = '<div class="tool-batch-header">'
            + '<span class="tool-type-icon"></span>'
            + '<span class="tool-status-icon loading"></span>'
            + '<span class="tool-batch-title"></span>'
            + '<span class="tool-batch-progress"></span>'
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
    }
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
window.normalizeBatchMeta = normalizeBatchMeta;

/* action_start：工具调用前（来源引擎 ActionChunk）提前渲染 loading 卡片骨架。
   - 有 actionId（并发/并行场景）：卡片按 id 登记到 sess.toolCardsById，action_end 靠 id 精确配对，
     不再依赖到达顺序；后端下发 batchId/batchIndex/batchSize 时归入显式批量容器分组展示。
   - 无 actionId（旧数据/兼容）：退回原有 sess.pendingToolCard 位置配对逻辑，行为不变。 */
function appendActionStartChunk(sess, toolName, args, toolTitle, actionId, agentBody, batchMeta) {
    if (actionId && sess.completedActionIds && sess.completedActionIds[actionId]) return;
    batchMeta = normalizeBatchMeta(batchMeta);
    ensureAssistantBubble(sess);

    var argsStr = formatToolArgsStr(args);
    var argsHtml = argsStr ? '<span class="tool-args">' + escapeHtml(argsStr) + '</span>' : '';

    var card = $('<div>').addClass('tool-card')[0];
    if (sess.currentRunId) {
        card.setAttribute('data-run-id', sess.currentRunId);
    }
    if (actionId) card.setAttribute('data-action-id', actionId);
    if (toolName) card.setAttribute('data-tool-name', toolName);
    if (window.cliPrintSimplified === false) $(card).addClass('expanded');
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-type-icon">' + toolTypeIcon(toolName) + '</span>'
        + '<span class="tool-status-icon loading"></span>'
        + '<span class="tool-name">' + escapeHtml(localizeToolName(toolName, toolTitle)) + '</span>'
        + argsHtml
        + '</div>'
        + '<div class="tool-card-body"></div>';
    tagToolName($(card).find('.tool-name')[0], toolName, toolTitle);
    updateToolHeaderMeta(card, toolName, args, null);

    $(card).find('.tool-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });

/* 确定插入容器：如果 args.agentName 存在，说明这是子代理内部的工具调用，
     应插入到对应的 .agent-card-body 容器内（复用主智能体样式），而不是主代理的气泡中 */
    var insertAgentBody = agentBody || resolveAgentCardBody(sess, args);

    if (actionId && !sess.approvedToolCard) {
        // id 模式：登记卡片，供 action_end 精确回填；后端显式批次时归入批量容器
        // （HITL 审批结果回填态例外——让位给位置配对，复用审批卡，避免多卡）
        if (!sess.toolCardsById) sess.toolCardsById = {};
        if (sess.toolCardsById[actionId]) {
            // 重复 action_start：忽略，不建第二张卡
            return;
        }
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
    if (iconEl) iconEl.textContent = toolTypeIcon(batch.toolName || null);
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
    if (iconEl) iconEl.textContent = toolTypeIcon(iconTool);
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
        var rootQ = (window.appMode === 'code' && window.currentProjectRoot) ? '&root=' + encodeURIComponent(window.currentProjectRoot) : '';
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

function appendActionEndChunk(sess, toolName, text, args, toolTitle, actionId, meta, agentBody, batchMeta) {
    // id 分支：并发/并行场景按 actionId 精确回填对应卡片（不依赖到达顺序），并推进批量分组进度。
    // 若正处于 HITL 审批结果回填态（sess.approvedToolCard 存在），让位给下方审批卡复用逻辑，避免两张卡。
    if (actionId && sess.completedActionIds && sess.completedActionIds[actionId]) return;
    if (actionId && !sess.approvedToolCard && sess.toolCardsById && sess.toolCardsById[actionId]) {
        var idCard = sess.toolCardsById[actionId];
        delete sess.toolCardsById[actionId];
        if (!sess.completedActionIds) sess.completedActionIds = {};
        sess.completedActionIds[actionId] = true;

        var idArgsStr = formatToolArgsStr(args);
        $(idCard).find('.tool-name').text(localizeToolName(toolName, toolTitle));
        tagToolName($(idCard).find('.tool-name')[0], toolName, toolTitle);
        updateToolHeaderMeta(idCard, toolName, args, text);
        var idArgsEl = $(idCard).find('.tool-args')[0];
        if (idArgsStr) {
            if (idArgsEl) { idArgsEl.textContent = idArgsStr; }
            else { $('<span>').addClass('tool-args').text(idArgsStr).insertAfter($(idCard).find('.tool-name')); }
        }
        var idBody = $(idCard).find('.tool-card-body')[0];
        if (idBody) {
            idBody.removeAttribute('style');
            idBody.innerHTML = '';
            fillToolBody(sess, idBody, toolName, text, args, meta);
        }
        setToolCardStatus(idCard, text);

        // 推进显式批量分组进度（方案 A）：根据卡片所属的 batchKey 定位批次，幂等推进。
        // 批次可能由 action_end 兜底创建，统一走 helper 保证计数口径一致。
        markBatchCardDone(sess, idCard);
        var idOwner = agentBody || resolveAgentCardBody(sess, args);
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
        var pcArgsStr = formatToolArgsStr(args);
        $(pc).find('.tool-name').text(localizeToolName(toolName, toolTitle));
        tagToolName($(pc).find('.tool-name')[0], toolName, toolTitle);
        updateToolHeaderMeta(pc, toolName, args, text);
        var pcArgsEl = $(pc).find('.tool-args')[0];
        if (pcArgsStr) {
            if (pcArgsEl) { pcArgsEl.textContent = pcArgsStr; }
            else { $('<span>').addClass('tool-args').text(pcArgsStr).insertAfter($(pc).find('.tool-name')); }
        }
        var pcBody = $(pc).find('.tool-card-body')[0];
        if (pcBody) {
            pcBody.removeAttribute('style');
            pcBody.innerHTML = '';
            fillToolBody(sess, pcBody, toolName, text, args, meta);
        }
        finishPendingTool(sess);
        setToolCardStatus(pc, text);
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
        if (toolName) fallbackCard.setAttribute('data-tool-name', toolName);
        if (window.cliPrintSimplified === false) $(fallbackCard).addClass('expanded');
        fallbackCard.innerHTML = '<div class="tool-card-header"><span class="tool-type-icon">' + toolTypeIcon(toolName) + '</span><span class="tool-status-icon loading"></span><span class="tool-name">' + escapeHtml(localizeToolName(toolName, toolTitle)) + '</span></div><div class="tool-card-body"></div>';
        tagToolName($(fallbackCard).find('.tool-name')[0], toolName, toolTitle);
        updateToolHeaderMeta(fallbackCard, toolName, args, text);
        fillToolBody(sess, $(fallbackCard).find('.tool-card-body')[0], toolName, text, args, meta);
        setToolCardStatus(fallbackCard, text);
        $(fallbackCard).find('.tool-card-header').on('click', function() { $(fallbackCard).toggleClass('expanded'); });
        var fallbackAgentBody = agentBody || resolveAgentCardBody(sess, args);
        if (appendCardToBatch(sess, fallbackCard, endBatchMeta, fallbackAgentBody)) markBatchCardDone(sess, fallbackCard);
        else if (fallbackAgentBody) $(fallbackAgentBody).append(fallbackCard);
        else insertBeforeActions(sess, fallbackCard);
        if (fallbackAgentBody) advanceAgentBodyPointer(sess, findAgentStateByBody(sess, fallbackAgentBody));
        else advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

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
    var argsHtml = '';
    if (args && typeof args === 'object') {
        var parts = [];
        var skipArgs = { diff: 1, content: 1, todos: 1 };
        Object.keys(args).forEach(function(k) {
            if (skipArgs[k]) return; parts.push(k + '=' + formatArgValue(args[k]));
        });
        var argsStr = parts.join(' ');
        if (argsStr.length > 80) argsStr = argsStr.substring(0, 77) + '...';
        if (argsStr) argsHtml = '<span class="tool-args">' + escapeHtml(argsStr) + '</span>';
    }

    // 复用分支：若刚批准过 HITL，结果渲染进同一张审批卡片，避免出现两张卡
    if (sess.approvedToolCard) {
        var rc = sess.approvedToolCard;
        sess.approvedToolCard = null;
        $(rc).find('.tool-name').text(localizeToolName(toolName, toolTitle));
        tagToolName($(rc).find('.tool-name')[0], toolName, toolTitle);
        updateToolHeaderMeta(rc, toolName, args, text);
        setToolCardStatus(rc, text);
        var rcArgsEl = $(rc).find('.tool-args')[0];
        if (argsStr) {
            if (rcArgsEl) { rcArgsEl.textContent = argsStr; }
            else { $('<span>').addClass('tool-args').text(argsStr).insertAfter($(rc).find('.tool-name')); }
        }
        var rcBody = $(rc).find('.tool-card-body')[0];
        if (rcBody) {
            rcBody.removeAttribute('style');
            rcBody.innerHTML = '';
            fillToolBody(sess, rcBody, toolName, text, args, meta);
        }
        if (window.cliPrintSimplified === false) $(rc).addClass('expanded');
        else $(rc).removeClass('expanded');
        sess.pendingToolCard = rc;
        advanceBodyPointer(sess, sess, function(el) { insertBeforeActions(sess, el); });
        if (sess.sessionId === activeSessionId) scrollToBottom();
        return;
    }

    var card = $('<div>').addClass('tool-card')[0];
    // 存储当前 runId，用于后续删除同一运行的消息
    if (sess.currentRunId) {
        card.setAttribute('data-run-id', sess.currentRunId);
    }
    if (window.cliPrintSimplified === false) $(card).addClass('expanded');
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-type-icon">' + toolTypeIcon(toolName) + '</span>'
        + '<span class="tool-status-icon loading"></span>'
        + '<span class="tool-name">' + escapeHtml(localizeToolName(toolName, toolTitle)) + '</span>'
        + argsHtml
        + '</div>'
        + '<div class="tool-card-body"></div>';
    tagToolName($(card).find('.tool-name')[0], toolName, toolTitle);
    updateToolHeaderMeta(card, toolName, args, text);

    // 工具结果渲染：委托注册表分发，未命中专用 renderer 则纯文本兜底；截断则挂展开按钮
    var toolBody = $(card).find('.tool-card-body')[0];
    fillToolBody(sess, toolBody, toolName, text, args, meta);
    setToolCardStatus(card, text);

    $(card).find('.tool-card-header').on('click', function() {
        $(card).toggleClass('expanded');
    });

    // 归属守卫：子代理的工具结果（无 action_start 前置建卡时）同样插入智能体卡片内部
    if (agentBody) {
        $(agentBody).append(card);
        advanceAgentBodyPointer(sess, findAgentStateByBody(sess, agentBody));
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
   而输入框上方的上下文指示条是「本次推理」口径（每轮 onReasonEnd 覆盖一次）。
   两者分母不同，数字天然对不上（尤其缓存命中率：累计值含首次冷缓存，按输入量加权后必然低于末次），
   并列展示会让用户误以为统计出错。故用量统一只在指示条展示一处。 */
function appendTraceBadge(sess, chunk) {
    ensureAssistantBubble(sess);
    // 后端携带的最终答案为权威复制源，写到当前 .md-content 的 data-md-raw（与历史消息统一属性名），供复制按钮读取。
    if (chunk.finalAnswer != null && sess.currentBubbleEl) {
        sess.currentBubbleEl.setAttribute('data-md-raw', chunk.finalAnswer);
    }
    function fmtSec(s) {
        if (s >= 60) { var m = Math.floor(s / 60), r = s % 60; return r > 0 ? m + 'min ' + r + 's' : m + 'min'; }
        return s + 's';
    }
    // 图标化：以小图标替代"耗时"文字标签，节省横向空间；title 保留完整中文语义以便悬停理解
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function item(icon, val, tip) {
        return '<span class="trace-item" title="' + esc(tip) + '"><span class="trace-ic">' + icon + '</span>' + esc(val) + '</span>';
    }
    var parts = [];
    if (chunk.elapsedSeconds != null) parts.push(item(TRACE_TIME_SVG, fmtSec(chunk.elapsedSeconds), GourdI18n.t('chat.elapsed_time')));
    if (parts.length === 0) return;

    // \u521b\u5efa\u6216\u66f4\u65b0 trace \u5143\u7d20
    var row = sess.currentBubbleEl ? $(sess.currentBubbleEl).closest('.msg-row')[0] : null;
    if (!row) return;

    var metaRow = $(row).find('.msg-meta-row')[0];
    if (!metaRow) return;

    var traceEl = $(metaRow).find('.msg-trace')[0];
    if (traceEl) {
        // \u5982\u679c\u5df2\u5b58\u5728\uff0c\u66f4\u65b0\u5185\u5bb9
        traceEl.innerHTML = parts.join('');
    } else {
        // \u5982\u679c\u4e0d\u5b58\u5728\uff0c\u521b\u5efa\u65b0\u7684 trace \u5143\u7d20
        var badge = $('<span>').addClass('msg-trace');
        badge[0].innerHTML = parts.join('');
        $(metaRow).append(badge[0]);
    }

    if (sess.sessionId === activeSessionId) scrollToBottom();
}

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
    var agentId = agentName + ':' + desc;
            
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
            // 去重守卫：卡片已有流式正文时（单任务 ReasonChunk 增量 / multitask ThoughtChunk 结果），
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
        + '<span class="agent-icon">🤖</span>'
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
    // 与思考块 thinkingUserScrolledUp 同口径）
    $(agentCardBody).on('scroll', function() {
        var gap = agentCardBody.scrollHeight - agentCardBody.scrollTop - agentCardBody.clientHeight;
        agentState.bodyUserScrolledUp = gap > 60;
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

/* 清理子智能体相关状态。传入 st 时仅清理该智能体（并行场景互不影响）；不传则全量清理。 */
function clearAgentState(sess, st) {
    if (st) {
        if (st.currentBubbleEl && st.currentBubbleEl._streamMd) st.currentBubbleEl._streamMd.dispose();
        if (st.thinkingBodyMdEl && st.thinkingBodyMdEl._streamMd) st.thinkingBodyMdEl._streamMd.dispose();
        stopThinkingTimer(st, 'thinkingBlockTimerId', 'thinkingBlockStartTime');
        if (sess.agentStates) delete sess.agentStates[st.id];
        if (sess._agentStateLast === st) sess._agentStateLast = null;
        return;
    }
    // 全量清理（流重置/会话切换）
    if (sess.agentStates) {
        for (var k in sess.agentStates) {
            var s = sess.agentStates[k];
            if (s.currentBubbleEl && s.currentBubbleEl._streamMd) s.currentBubbleEl._streamMd.dispose();
            if (s.thinkingBodyMdEl && s.thinkingBodyMdEl._streamMd) s.thinkingBodyMdEl._streamMd.dispose();
            stopThinkingTimer(s, 'thinkingBlockTimerId', 'thinkingBlockStartTime');
        }
        sess.agentStates = {};
    }
    // agentCards 必须与 agentStates 同步清空：它以 agentName+':'+desc 为键持有 .agent-card DOM 强引用，
    // 而 desc 每次任务都不同（不会覆盖旧键），仅在配对 agent_end 到达时才 delete（见本文件 agent_end 分支）。
    // 中断/报错/丢帧时条目永久残留，会钉住已被 evictInactiveSessions 的 $(container).empty() 摘除的
    // 卡片子树，使其无法 GC（连带卡片内各 .md-content 上的 _streamMd.buf 全文），
    // 表现为「清了 DOM 内存却不降」。注意：断线恢复路径会先保存再回填 agentCards
    // （app-history.js 的 resumeState），此处清空不影响该路径。
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

// 启动等待指示器：尚无气泡时，在消息区独立显示一行「圆点 + Ns」（无文字）
function showThinking(sess) {
    removeThinking(sess);
    sess.thinkingEl = $('<div>').addClass('thinking-row')[0];
    sess.thinkingEl.innerHTML = '<div class="thinking-bubble">' + DOTS_HTML 
        + '<span class="thinking-timer-wrap">'
        + '<span class="thinking-current-timer">0s</span>'
        + '</span></div>';
    $(sess.container).append(sess.thinkingEl);
    var currentTimerSpan = $(sess.thinkingEl).find('.thinking-current-timer')[0];
    startThinkingTimer(sess, 'thinkingTimerId', 'thinkingStartTime', currentTimerSpan);
    if (sess.sessionId === activeSessionId) scrollToBottom(true);
}
function removeThinking(sess) {
    stopThinkingTimer(sess, 'thinkingTimerId', 'thinkingStartTime');
    if (sess.thinkingEl) { $(sess.thinkingEl).remove(); sess.thinkingEl = null; }
}

// 气泡内的间隙等待指示器（「圆点 + Ns」，无文字）。
// 关键：元素一旦创建便常驻气泡底部（actions 之前），不可见时用 visibility:hidden 占位，
// 避免显隐导致的高度跳动；流式结束时再由 purgeInlineThinking 彻底移除。
function ensureInlineThinking(sess) {
    if (!sess.currentBubbleEl) return null;
    if (sess.inlineThinkingEl && sess.inlineThinkingEl.parentNode) return sess.inlineThinkingEl;
    var el = $('<div>').addClass('inline-thinking hidden-reserve')[0];
    el.innerHTML = DOTS_HTML + '<span class="thinking-timer-wrap">'
        + '<span class="thinking-current-timer">0s</span>'
        + '</span>';
    sess.inlineThinkingEl = el;
    // 指示器固定在正文底部、页脚（meta 行/操作按钮）之上，使正文与用量行的相对顺序恒为「正文 → meta」。
    var bubble = sess.currentBubbleEl.parentNode;
    var footer = $(bubble).find('.msg-meta-row').first()[0] || $(bubble).find('.msg-actions').first()[0];
    if (footer) $(footer).before(el);
    return el;
}
function showInlineThinking(sess) {
    var el = ensureInlineThinking(sess);
    if (!el) return;
    $(el).removeClass('hidden-reserve');
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
function appendHitlCard(sess, toolName, command) {
    ensureAssistantBubble(sess);

    // 采用 tool-card 视觉体系：审批通过后原地复用为工具结果卡片
    var argsHtml = command ? '<span class="tool-args">' + escapeHtml(command) + '</span>' : '';
    var card = $('<div>').addClass('tool-card hitl-pending expanded')[0];
    // 存储当前 runId，用于后续删除同一运行的消息
    if (sess.currentRunId) {
        card.setAttribute('data-run-id', sess.currentRunId);
    }
    card.innerHTML = '<div class="tool-card-header">'
        + '<span class="tool-status-icon warn"><i class="layui-icon layui-icon-tips" style="font-size:13px"></i></span>'
        + '<span class="tool-name">' + GourdI18n.t('chat.need_auth') + escapeHtml(toolName || 'unknown') + '</span>'
        + argsHtml
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

    insertBeforeActions(sess, card);

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
        handleHitlResponse(sess, 'approve');
    });

    $(rejectBtn).on('click', function() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        var icon = $(card).find('.tool-status-icon')[0];
        if (icon) { icon.className = 'tool-status-icon reject'; icon.innerHTML = ''; }
        $(card).find('.tool-name').text(GourdI18n.t('chat.rejected') + (toolName || 'unknown'));
        (function() { var hn = $(card).find('.tool-name')[0]; if (hn) { hn.setAttribute('data-i18n-hitl', 'rejected'); hn.setAttribute('data-i18n-hitl-tool', toolName || 'unknown'); } })();
        $(card).find('.hitl-card-actions').remove();
        $(card).removeClass('hitl-pending expanded');
        sess.approvedToolCard = null;
        handleHitlResponse(sess, 'reject');
    });

    if (sess.sessionId === activeSessionId) scrollToBottom();
}

function handleHitlResponse(sess, action) {
    if (sess.eventSource) { sess.eventSource.close(); sess.eventSource = null; }
    resetStreamState(sess);

    sess.isStreaming = true;
    if (sess.sessionId === activeSessionId) {
        isStreaming = true;
        setBtnStopMode();
    }
    showThinking(sess);

    // 通过 HTTP POST 发送 HITL 决策，结果通过 WebSocket 推送
    var formData = new FormData();
    formData.append('hitlAction', action);
    formData.append('sessionId', sess.sessionId);

    // HITL 属当前会话的续轮：优先用会话自身记录的工作空间根，避免工作空间切换后错位
    var hitlHeaders = {};
    var hitlCwd = (sess && sess.projectRoot) ? sess.projectRoot : (typeof getSessionCwd === 'function' ? getSessionCwd() : '');
    if (hitlCwd) hitlHeaders['X-Session-Cwd'] = hitlCwd;
    fetch(SSE_ENDPOINT, {
        method: 'POST',
        body: formData,
        headers: hitlHeaders
    }).then(function(resp) {
        // HTTP 响应只有 {"status":"ok"}，实际数据通过 WebSocket 推送
    }).catch(function(err) {
        console.error('HITL error:', err);
        // 通过回调占位调用 finishStream（由 app-streaming.js 注册）
        if (onFinishStream) onFinishStream(sess);
    });
}

/* ===== Rewind Handling ===== */
function handleRewind(sess, count) {
    if (count <= 0) return;
    // count = 要删除的消息条数，从末尾倒序删除
    var toRemove = count;
    var rows = $(sess.container).find('.msg-row');
    var actual = Math.min(toRemove, rows.length);
    for (var i = 0; i < actual; i++) {
        $(rows[rows.length - 1]).remove();
        rows = $(sess.container).find('.msg-row');
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
function tagToolName(el, toolName, toolTitle) {
    if (!el) return;
    el.setAttribute('data-i18n-tool', toolName == null ? '' : toolName);
    if (toolTitle) el.setAttribute('data-i18n-tooltitle', toolTitle);
    else el.removeAttribute('data-i18n-tooltitle');
}
window.tagToolName = tagToolName;

function relocalizeDynamicLabels() {
    if (!window.GourdI18n) return;
    document.querySelectorAll('.tool-name[data-i18n-tool]').forEach(function(el) {
        el.textContent = localizeToolName(el.getAttribute('data-i18n-tool'), el.getAttribute('data-i18n-tooltitle') || null);
    });
    document.querySelectorAll('.tool-name[data-i18n-hitl]').forEach(function(el) {
        el.textContent = GourdI18n.t('chat.' + el.getAttribute('data-i18n-hitl')) + (el.getAttribute('data-i18n-hitl-tool') || 'unknown');
    });
    document.querySelectorAll('.tool-batch-title[data-i18n-batch-tool]').forEach(function(el) {
        var tn = el.getAttribute('data-i18n-batch-tool');
        var c = el.getAttribute('data-i18n-batch-count') || '0';
        el.textContent = batchTitleText(tn || null, c);
    });
    document.querySelectorAll('.thinking-block-label[data-i18n-thinking]').forEach(function(el) {
        var st = el.getAttribute('data-i18n-thinking');
        var suffix = el.getAttribute('data-i18n-elapsed') || '';
        el.textContent = GourdI18n.t(st === 'finished' ? 'chat.thinking_finished' : 'chat.thinking_in_progress') + suffix;
    });
}
window.relocalizeDynamicLabels = relocalizeDynamicLabels;
document.addEventListener('i18n:localeChanged', relocalizeDynamicLabels);
