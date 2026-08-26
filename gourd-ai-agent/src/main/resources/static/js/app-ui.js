/* ===== app-ui.js ===== */
/* 界面交互：附件 + 主题 + 视图 + 语音 + 侧栏 + Markdown */
/* 依赖：app-base.js */

/* ===== Attachment Helpers ===== */
var welcomeAttachmentsWrap = $('#welcomeAttachmentsWrap');
var chatAttachmentsWrap = $('#chatAttachmentsWrap');
// 异步操作版本号：每次清空 pendingFiles 时递增，FileReader 回调中校验版本号来避免过期写入
var _pendingFilesVersion = 0;

// Generate unique image extension from MIME type
function getImageExtension(mimeType) {
    if (!mimeType) return 'png';
    switch (mimeType) {
        case 'image/jpeg': return 'jpg';
        case 'image/png': return 'png';
        case 'image/gif': return 'gif';
        case 'image/webp': return 'webp';
        case 'image/bmp': return 'bmp';
        case 'image/svg+xml': return 'svg';
        case 'image/tiff': return 'tiff';
        default: return 'png';
    }
}

// Get file extension from filename (for non-image files) or MIME type (for images)
function getFileExtension(file) {
    if (!file) return 'dat';
    // If it's a File/Blob object with name property, extract from name
    if (typeof file.name === 'string') {
        var parts = file.name.split('.');
        if (parts.length > 1) return parts.pop().toLowerCase();
    }
    // Fallback: try to derive from MIME type
    if (typeof file.type === 'string' && file.type) {
        return file.type.split('/').pop().split('+')[0];
    }
    return 'dat';
}

// Generate unique file name with timestamp + random
function generateUniqueFile(originalFile, prefix) {
    if (!originalFile) return null;
    var timestamp = Date.now();
    var random = Math.random().toString(36).substring(2, 8);
    var ext = getFileExtension(originalFile);
    var newName = prefix + '-' + timestamp + '-' + random + '.' + ext;
    return new File([originalFile], newName, { type: originalFile.type, lastModified: Date.now() });
}

// Release large data from a file attachment object (base64 dataUrl + raw File)
// Keep only lightweight metadata (name, size, type) for display purposes
function releaseAttachmentData(item) {
    if (!item) return;
    if (item.dataUrl) { item.dataUrl = null; }
    if (item.blob) { item.blob = null; }
    if (item.file) { item.file = null; }
}

function handlePaste(e) {
    var clipboard = e.clipboardData || e.originalEvent.clipboardData;
    if (!clipboard) return;

    var items = clipboard.items;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            var file = items[i].getAsFile();
            if (!file) continue; // 防御：getAsFile() 可能返回 null
            // 生成唯一文件名，避免覆盖
            var ext = getImageExtension(items[i].type) || 'png';
            file = generateUniqueFile(file, 'pasted-image');
            processSelectedFile(file, 'image');
            return;
        }
    }

    // Handle HTML paste: convert to text preserving formatting
    var htmlData = clipboard.getData('text/html');
    if (htmlData) {
        e.preventDefault();
        var text = clipboard.getData('text/plain') || '';
        // If plain text has content, use it directly (preserves newlines/indentation)
        // textarea.value = text already preserves formatting
        var textarea = e.target;
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var before = textarea.value.substring(0, start);
        var after = textarea.value.substring(end);
        textarea.value = before + text + after;
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
        autoResize(textarea);
        // Trigger input event for command completion
        $(textarea).trigger('input');
    }
}

function getAttachmentsWrap() {
    return inChatMode ? chatAttachmentsWrap : welcomeAttachmentsWrap;
}

function renderAttachments() {
    // Render both wraps to keep them in sync when switching views
    renderAttachmentsWrap(welcomeAttachmentsWrap);
    renderAttachmentsWrap(chatAttachmentsWrap);
}

function renderAttachmentsWrap(wrap) {
    wrap.html('');
    if (pendingFiles.length === 0) {
        wrap.removeClass('has-items');
        return;
    }
    wrap.addClass('has-items');
    for (var i = 0; i < pendingFiles.length; i++) {
        var item = pendingFiles[i];
        var el = document.createElement('div');
        el.className = 'attachment-item';
        var typeTag = '<span class="attachment-type-tag ' + (item.attachmentsType || 'file') + '">' + (item.attachmentsType === 'image' ? GourdI18n.t('ui.multimodal') : GourdI18n.t('ui.file')) + '</span>';
        if (item.type === 'image') {
            $(el).html('<img src="' + item.dataUrl + '"/>'
                + typeTag
                + '<button class="attachment-item-remove" data-idx="' + i + '">&times;</button>');
        } else {
            $(el).html('<div class="attachment-item-file">'
                + '<span class="file-icon">📎</span>'
                + '<span class="file-name">' + escapeHtml(item.name) + '</span>'
                + '</div>'
                + typeTag
                + '<button class="attachment-item-remove" data-idx="' + i + '">&times;</button>');
        }
        wrap.append(el);
    }
}

function clearAttachmentPreview() {
    // 先释放附件中的大对象（dataUrl、file），避免内存积压
    for (var k = 0; k < pendingFiles.length; k++) {
        releaseAttachmentData(pendingFiles[k]);
    }
    pendingFiles.length = 0;
    renderAttachments();
    // 重置异步操作版本号，使后续到达的旧回调失效
    _pendingFilesVersion++;
}

function removeAttachment(idx) {
    if (idx >= 0 && idx < pendingFiles.length) {
        releaseAttachmentData(pendingFiles[idx]);
        pendingFiles.splice(idx, 1);
        renderAttachments();
    }
}

function processSelectedFile(file, attachmentsType) {
    if (!file) return;
    if (pendingFiles.length >= MAX_ATTACHMENTS) return;

    // 捕获当前版本号，用于后续异步回调校验
    var currentVersion = _pendingFilesVersion;

    // 生成唯一文件名，避免服务端 uploads/ 目录同名覆盖
    var uniqueFile = generateUniqueFile(file, 'attachment');

    if (attachmentsType === 'image') {
        // Image attachment: always treated as multimodal image
        var reader = new FileReader();
        reader.onload = function(evt) {
            if (_pendingFilesVersion !== currentVersion) return; // 过期回调，丢弃
            pendingFiles.push({ type: 'image', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, dataUrl: evt.target.result, attachmentsType: 'image' });
            renderAttachments();
        };
        reader.onerror = function() {
            console.error('[Attachment] Image read failed:', uniqueFile.name);
        };
        reader.readAsDataURL(uniqueFile);
    } else if (file.type.indexOf('image') !== -1) {
        // File attachment + image file: show preview but mark as file type
        var reader = new FileReader();
        reader.onload = function(evt) {
            if (_pendingFilesVersion !== currentVersion) return; // 过期回调，丢弃
            pendingFiles.push({ type: 'image', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, dataUrl: evt.target.result, attachmentsType: 'file' });
            renderAttachments();
        };
        reader.onerror = function() {
            console.error('[Attachment] Image preview read failed:', uniqueFile.name);
        };
        reader.readAsDataURL(uniqueFile);
    } else {
        pendingFiles.push({ type: 'file', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, attachmentsType: 'file' });
        renderAttachments();
    }
}

function processSelectedFiles(fileList, attachmentsType) {
    for (var i = 0; i < fileList.length; i++) {
        if (pendingFiles.length >= MAX_ATTACHMENTS) break;
        processSelectedFile(fileList[i], attachmentsType);
    }
}

$(welcomeInput).on('paste', handlePaste);
$(chatInput).on('paste', handlePaste);

/* ===== Drag & Drop File Upload ===== */
(function() {
    var welcomeDropZone = $('#welcomeDropZone');
    var chatDropZone = $('#chatDropZone');
    var welcomeDropOverlay = $('#welcomeDropOverlay');
    var chatDropOverlay = $('#chatDropOverlay');

    // Counter to track nested enter/leave events (child elements fire their own events)
    var welcomeDragCounter = 0;
    var chatDragCounter = 0;

    function showOverlay(overlay) {
        overlay.addClass('active');
    }

    function hideOverlay(overlay) {
        overlay.removeClass('active');
    }

    function handleDrop(e, overlay, counterReset) {
        e.preventDefault();
        e.stopPropagation();
        counterReset.val = 0;
        hideOverlay(overlay);

        var dt = e.dataTransfer || (e.originalEvent && e.originalEvent.dataTransfer);
        var files = dt && dt.files;
        if (!files || files.length === 0) return;

        if (pendingFiles.length >= MAX_ATTACHMENTS) {
            showToast(GourdI18n.t('ui.attachment_limit', MAX_ATTACHMENTS), 'error');
            return;
        }

        // Separate files into images and non-images for proper processing
        for (var i = 0; i < files.length; i++) {
            if (pendingFiles.length >= MAX_ATTACHMENTS) {
                showToast(GourdI18n.t('ui.attachment_partial_limit', MAX_ATTACHMENTS), 'error');
                break;
            }
            var file = files[i];
            if (!file) continue; // 防御：文件可能被移除
            var isImage = file.type.indexOf('image/') === 0;
            processSelectedFile(file, isImage ? 'image' : 'file');
        }
    }

    function bindDropZone(zone, overlay, counter) {
        // Prevent default browser behavior (opening the file)
        zone.on('dragenter', function(e) {
            e.preventDefault();
            e.stopPropagation();
            counter.val++;
            showOverlay(overlay);
        });

        zone.on('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // Keep overlay visible during drag over
        });

        zone.on('dragleave', function(e) {
            e.preventDefault();
            e.stopPropagation();
            counter.val--;
            if (counter.val <= 0) {
                counter.val = 0;
                hideOverlay(overlay);
            }
        });

        zone.on('drop', function(e) {
            handleDrop(e, overlay, counter);
        });
    }

    bindDropZone(welcomeDropZone, welcomeDropOverlay, { val: welcomeDragCounter });
    bindDropZone(chatDropZone, chatDropOverlay, { val: chatDragCounter });
})();

// Attachment remove buttons - use event delegation on both wraps
welcomeAttachmentsWrap.on('click', function(e) {
    var btn = e.target.closest('.attachment-item-remove');
    if (btn) removeAttachment(parseInt(btn.getAttribute('data-idx')));
});
chatAttachmentsWrap.on('click', function(e) {
    var btn = e.target.closest('.attachment-item-remove');
    if (btn) removeAttachment(parseInt(btn.getAttribute('data-idx')));
});

// Attach button handlers
$('#welcomeAttachBtn').on('click', function(e) {
    e.stopPropagation();
    $('#welcomeAttachInput')[0].click();
});
$('#chatAttachBtn').on('click', function(e) {
    e.stopPropagation();
    $('#chatAttachInput')[0].click();
});
$('#welcomeAttachInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'file');
    e.target.value = '';
});
$('#chatAttachInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'file');
    e.target.value = '';
});

// Image button handlers
$('#welcomeImageBtn').on('click', function(e) {
    e.stopPropagation();
    $('#welcomeImageInput')[0].click();
});
$('#chatImageBtn').on('click', function(e) {
    e.stopPropagation();
    $('#chatImageInput')[0].click();
});
$('#welcomeImageInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'image');
    e.target.value = '';
});
$('#chatImageInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'image');
    e.target.value = '';
});

/* ===== Plus 聚合菜单（“+”弹出菜单，chat/code 模式共用） =====
   菜单项沿用原工具条按钮 ID（attach/image/cmd/skill/agent/loop/history），
   各自的动作绑定（app-ui/app-history）无需改动，这里只负责菜单本身的开关。 */
(function() {
    var $plusWraps = $('.plus-menu-wrap');
    if (!$plusWraps.length) return;
    function closePlusMenus(exceptEl) {
        $plusWraps.each(function() {
            if (this !== exceptEl) $(this).removeClass('open');
        });
    }
    $plusWraps.each(function() {
        var wrapEl = this;
        var $wrap = $(wrapEl);
        // “+”按钮：开关菜单，并与其他弹出面板互斥
        $wrap.find('.plus-btn').on('click', function(e) {
            e.stopPropagation();
            var opening = !$wrap.hasClass('open');
            closePlusMenus(wrapEl);
            if (opening && typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels();
            $wrap.toggleClass('open', opening);
        });
        // 菜单项点击后先执行各自绑定的动作（选文件/命令补全/面板等），再统一收起菜单；
        // setTimeout 保证晚于同元素上的所有处理器（部分动作带 stopPropagation，不能用委托）
        $wrap.find('.plus-menu-item').on('click', function() {
            setTimeout(function() { $wrap.removeClass('open'); }, 0);
        });
    });
    // 点击菜单外部关闭
    $(document).on('mousedown', function(e) {
        if (!$(e.target).closest('.plus-menu-wrap').length) closePlusMenus(null);
    });
    // Esc 关闭
    $(document).on('keydown', function(e) {
        if (e.key === 'Escape') closePlusMenus(null);
    });
})();

/* ===== Marked ===== */
if (typeof marked !== 'undefined') { marked.setOptions({ breaks: true, gfm: true }); }
var _mdCache = new Map();
var _MD_CACHE_MAX = 100;
var _MD_CACHE_MAX_LENGTH = 5000; // 超过此长度的文本不缓存（避免大字符串 Key 占用过多内存）
function renderMd(text) {
    if (typeof marked !== 'undefined') {
        if (!text) return '';
        if (text.length < _MD_CACHE_MAX_LENGTH) {
            var cached = _mdCache.get(text);
            if (cached) return cached;
            var html = marked.parse(text);
            _mdCache.set(text, html);
            if (_mdCache.size > _MD_CACHE_MAX) {
                var firstKey = _mdCache.keys().next().value;
                _mdCache.delete(firstKey);
            }
            return html;
        }
        return marked.parse(text);
    }
    return text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

/* 清空 Markdown 缓存（供会话切换/回放结束时调用，释放临时内存） */
function clearMdCache() {
    _mdCache.clear();
}
window.clearMdCache = clearMdCache;

/* ===== 流式增量 Markdown 渲染器（修复展开态逐帧闪烁） =====
 * 根因：传统流式渲染每帧 `el.innerHTML = renderMd(全量缓冲)`，展开后浏览器每帧
 * 重建全部 DOM 节点并对可见大子树做全量 style/layout/paint → 整块闪烁，输出越多越严重。
 * 增量策略（每帧成本 O(tail) 而非 O(全量)）：
 *  - stable 段：经 marked.lexer 确认已闭合的块级 token，直挂 host（保持 .md-content 直接子级结构，
 *    兼容现有 `> :first-child` 等 CSS），insertAdjacentHTML 只追加一次、永不重建；
 *  - tail 段：仅最后一个未完成块，包在单个 .md-stream-tail 里每帧重建（空 div 无边框/padding，
 *    外边距可穿透折叠，视觉与平铺渲染一致）；
 *  - 未闭合代码围栏：常驻 <pre><code>，用文本节点 O(delta) 追加，围栏闭合时整块渲染归入 stable；
 *  - finish()：一次性全量渲染收尾，保证最终结果与传统渲染逐字一致（高亮/mermaid/按钮仍由调用方执行）。
 * 渲染器只接管元素的「流式阶段」；一次性 renderMd 路径（历史加载/用户消息等）不受影响。 */
/*STREAMMD-START*/
function createStreamMd(hostEl) {
    var r = {
        host: hostEl,
        buf: '',
        stableLen: 0,
        inFence: false,
        fenceMarker: '',
        fenceStart: 0,
        fenceFrom: 0,
        fenceConsumed: 0,
        tailEl: null,
        fencePre: null,
        fenceCode: null,
        rafId: 0,
        timerId: 0,
        active: false,
        afterRender: null
    };
    function ensureTail() {
        if (!r.tailEl) {
            r.tailEl = document.createElement('div');
            r.tailEl.className = 'md-stream-tail';
            r.host.appendChild(r.tailEl);
        }
    }
    function schedule() {
        if (r.rafId || r.timerId) return;
        // 桌面窗口被遮挡/最小化时 Chromium 会停发 rAF（默认 backgroundThrottling），
        // 纯 rAF 调度会让流式渲染整个冻结、结尾一次性补画（"攒批"假象）。
        // 故 rAF 之外恒挂一个定时器兜底（遮挡时 document.hidden 仍为 false，单靠 hidden 判不够），
        // 谁先唤醒谁驱动 tick，另一个在 tick 开头取消。
        r.timerId = setTimeout(tick, 120);
        if (!(typeof document !== 'undefined' && document.hidden)) {
            r.rafId = requestAnimationFrame(tick);
        }
    }
    function mdParse(t) {
        if (typeof marked !== 'undefined') return marked.parse(t);
        return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    }
    function mdEscape(t) {
        return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    // 在 rem 中查找围栏开启行（行首最多 3 空格），返回 {index, marker, headLen, lang} 或 null
    function findFenceOpen(rem) {
        var re = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;
        var m;
        while ((m = re.exec(rem))) {
            // 开启行尚未结束（流式半行，m[0] 后无 \n）时不判定，等行完整再确认，
            // 避免半行误判（如 info string 的反引号稍后才到达）
            if (m.index + m[0].length >= rem.length) continue;
            // CommonMark：反引号围栏的 info string 不得含反引号，此类行不是围栏开启（与 marked 判定对齐）
            if (m[1].charAt(0) === '`' && m[2].indexOf('`') >= 0) continue;
            return { index: m.index, marker: m[1], headLen: m[0].length, lang: (m[2] || '').trim() };
        }
        return null;
    }
    // 从 from 起查找与 marker 同字符、长度不小于它的围栏关闭行，返回该行结束偏移（含行尾 \n），-1 为未闭合
    function findFenceClose(buf, from, marker) {
        var re = /^ {0,3}(`{3,}|~{3,})[ \t]*$/gm;
        re.lastIndex = from;
        var m = re.exec(buf);
        while (m) {
            var run = m[1];
            if (run.charAt(0) === marker.charAt(0) && run.length >= marker.length) return re.lastIndex;
            m = re.exec(buf);
        }
        return -1;
    }
    function tick() {
        if (r.timerId) { clearTimeout(r.timerId); r.timerId = 0; }
        if (r.rafId) { cancelAnimationFrame(r.rafId); r.rafId = 0; }
        var more = false;
        try {
            var guard = 0;
            while (guard++ < 8) {
                if (r.inFence) {
                    var closeAt = findFenceClose(r.buf, r.fenceFrom, r.fenceMarker);
                    if (closeAt < 0) {
                        // 未闭合：常驻 code 以文本节点追加新增内容（O(delta)，不重建 DOM）
                        if (r.buf.length > r.fenceConsumed) {
                            r.fenceCode.appendChild(document.createTextNode(r.buf.slice(r.fenceConsumed)));
                            r.fenceConsumed = r.buf.length;
                        }
                        break;
                    }
                    // 闭合：整块渲染归入 stable，移除常驻 pre
                    var seg = r.buf.slice(r.fenceStart, closeAt);
                    if (r.fencePre && r.fencePre.parentNode) r.fencePre.parentNode.removeChild(r.fencePre);
                    r.fencePre = null; r.fenceCode = null;
                    ensureTail();
                    r.tailEl.innerHTML = '';
                    r.tailEl.insertAdjacentHTML('beforebegin', mdParse(seg));
                    r.stableLen = closeAt;
                    r.inFence = false;
                    continue;
                }
                var rem = r.buf.slice(r.stableLen);
                if (!rem) break;
                var open = findFenceOpen(rem);
                var lexSrc = open ? rem.slice(0, open.index) : rem;
                var tokens = null;
                if (lexSrc && typeof marked !== 'undefined') {
                    try { tokens = marked.lexer(lexSrc); } catch (e) { tokens = null; }
                } else if (lexSrc) tokens = null;
                else tokens = [];
                if (!tokens) {
                    // lexer 异常兜底：尾部整体渲染，不推进 stable
                    ensureTail();
                    r.tailEl.innerHTML = mdParse(rem);
                    break;
                }
                var commit = 0;
                if (open) commit = tokens.length;
                else if (tokens.length) commit = (tokens[tokens.length - 1].type === 'space') ? tokens.length : tokens.length - 1;
                if (commit > 0) {
                    var raw = '';
                    for (var i = 0; i < commit; i++) {
                        if (tokens[i].raw == null) { raw = ''; commit = 0; break; }
                        raw += tokens[i].raw;
                    }
                    if (commit > 0) {
                        ensureTail();
                        r.tailEl.insertAdjacentHTML('beforebegin', mdParse(raw));
                        r.stableLen += raw.length;
                        // 提交进 stable 后必须清空 tail：tail 里画的是「上一帧的未提交尾部」，
                        // 该内容此刻已随 raw 落入 stable。若本轮 commit 覆盖了全部 token
                        // （如正文以空行 \n\n 收尾，末 token 为 space 走 tokens.length 全提交），
                        // 循环下一轮 rem 为空即 break，L573 的空 tail 清理又因 tail 非空不成立，
                        // 于是 stable 一份完整 + tail 一份缺尾并列显示 → 正文重复。
                        r.tailEl.innerHTML = '';
                        continue;
                    }
                }
                if (open) {
                    // 进入围栏流式态：常驻 pre/code，开启行之后为正文起点
                    ensureTail();
                    r.tailEl.innerHTML = '';
                    r.inFence = true;
                    r.fenceMarker = open.marker;
                    r.fenceStart = r.stableLen + open.index;
                    r.fenceFrom = r.fenceStart + open.headLen;
                    var bodyStart = r.fenceFrom;
                    if (r.buf.charAt(bodyStart) === '\n') bodyStart++;
                    r.fenceConsumed = bodyStart;
                    r.fencePre = document.createElement('pre');
                    r.fenceCode = document.createElement('code');
                    var lang = open.lang.split(/\s+/)[0];
                    if (lang) r.fenceCode.className = 'language-' + lang.replace(/[^\w+#.-]/g, '');
                    r.fencePre.appendChild(r.fenceCode);
                    r.tailEl.appendChild(r.fencePre);
                    continue;
                }
                // 无围栏：tail = 未提交的最后一个 token（极小，每帧重建无感知）
                ensureTail();
                if (commit < tokens.length) {
                    var tailRaw = '';
                    for (var t2 = commit; t2 < tokens.length; t2++) tailRaw += (tokens[t2].raw || '');
                    r.tailEl.innerHTML = tailRaw.trim() ? mdParse(tailRaw) : '';
                } else r.tailEl.innerHTML = '';
                break;
            }
            more = guard >= 8;
        } catch (e) {
            try { ensureTail(); r.tailEl.innerHTML = mdEscape(r.buf.slice(r.stableLen)); } catch (e2) {}
        }
        // 空 tail 包裹层当帧移除：避免残留空 div 抢占 :last-child，使流式态外边距与全量渲染收敛一致
        if (!r.inFence && r.tailEl && !r.tailEl.firstChild) {
            if (r.tailEl.parentNode) r.tailEl.parentNode.removeChild(r.tailEl);
            r.tailEl = null;
        }
        if (more) schedule();
        if (r.afterRender) { try { r.afterRender(); } catch (e3) {} }
    }
    r.append = function (text) {
        if (!text) return;
        if (!r.active) {
            r.active = true;
            if (r.host.firstChild) r.host.innerHTML = '';
            r.tailEl = null; r.stableLen = 0; r.inFence = false; r.buf = '';
        }
        r.buf += text;
        schedule();
    };
    r.replace = function (text) {
        r.active = true;
        r.host.innerHTML = '';
        r.tailEl = null; r.fencePre = null; r.fenceCode = null;
        r.stableLen = 0; r.inFence = false;
        r.buf = text || '';
        if (r.buf) schedule();
    };
    r.finish = function () {
        if (r.timerId) { clearTimeout(r.timerId); r.timerId = 0; }
        if (r.rafId) { cancelAnimationFrame(r.rafId); r.rafId = 0; }
        if (!r.active) return;
        r.active = false;
        r.host.innerHTML = mdParse(r.buf);
        r.tailEl = null; r.fencePre = null; r.fenceCode = null;
        r.stableLen = r.buf.length; r.inFence = false;
    };
    r.dispose = function () {
        // 仅取消挂起帧与回调；保留 active/buf，保证 dispose 后仍可 finish() 全量收尾
        if (r.timerId) { clearTimeout(r.timerId); r.timerId = 0; }
        if (r.rafId) { cancelAnimationFrame(r.rafId); r.rafId = 0; }
        r.afterRender = null;
    };
    return r;
}
function getStreamMd(el) {
    if (!el._streamMd) el._streamMd = createStreamMd(el);
    return el._streamMd;
}
/* 处置会话级流式渲染器（取消挂起帧；不改动 DOM）。会话切换/删除/流收尾时调用。 */
function disposeSessionStreamMd(sess) {
    if (!sess) return;
    if (sess.currentBubbleEl && sess.currentBubbleEl._streamMd) sess.currentBubbleEl._streamMd.dispose();
    if (sess.thinkingBodyMdEl && sess.thinkingBodyMdEl._streamMd) sess.thinkingBodyMdEl._streamMd.dispose();
    if (sess.agentStates) {
        for (var k in sess.agentStates) {
            var st = sess.agentStates[k];
            if (st && st.currentBubbleEl && st.currentBubbleEl._streamMd) st.currentBubbleEl._streamMd.dispose();
            if (st && st.thinkingBodyMdEl && st.thinkingBodyMdEl._streamMd) st.thinkingBodyMdEl._streamMd.dispose();
        }
    }
}
/*STREAMMD-END*/

/* ===== Highlight.js ===== */
function highlightCodeBlocks(container) {
    if (!container || typeof hljs === 'undefined') return;
    var blocks = $(container).find('pre code:not([data-hljs-collected]):not(.language-mermaid)');
    if (blocks.length === 0) return;
    blocks.each(function() { this.dataset.hljsCollected = 'true'; });
    
    // 分片高亮：当代码块数量较多时，分帧处理以避免阻塞
    var HLJS_CHUNK_SIZE = 10; // 每帧处理 10 个代码块
    var idx = 0;
    var total = blocks.length;
    
    function highlightChunk() {
        var end = Math.min(idx + HLJS_CHUNK_SIZE, total);
        for (; idx < end; idx++) {
            var block = blocks[idx];
            if (block && !block.dataset.hljsHighlighted) {
                block.dataset.hljsHighlighted = 'true';
                try { hljs.highlightElement(block); } catch(e) {}
            }
        }
        if (idx < total) {
            requestAnimationFrame(highlightChunk);
        }
    }
    
    // 代码块少于阈值时直接同步处理，避免不必要的分片开销
    if (total <= HLJS_CHUNK_SIZE) {
        highlightChunk();
    } else {
        requestAnimationFrame(highlightChunk);
    }
}

/* ===== Mermaid（按需加载）=====
   mermaid.min.js 约 3.2MB（含 katex/cytoscape/langium 等），解析+常驻内存约 25-40MB，
   而绝大多数对话不含 mermaid 图表 —— 原先在 index.html 同步 <script> 无条件加载是纯浪费。
   改为：processMermaidBlocks 发现确有 .language-mermaid 代码块时才注入脚本。
   脚本末尾会设置 globalThis.mermaid，故 onload 后即可直接使用。 */
var __mermaidState = 0;   // 0=未加载 1=加载中 2=已就绪 3=加载失败
var __mermaidQueue = [];

function __mermaidLoad(cb) {
    if (__mermaidState === 2) { cb(window.mermaid); return; }
    if (__mermaidState === 3) { cb(null); return; }
    __mermaidQueue.push(cb);
    if (__mermaidState === 1) return;
    __mermaidState = 1;

    var s = document.createElement('script');
    s.src = '/js/mermaid.min.js';
    s.async = true;
    s.onload = function () {
        __mermaidState = (typeof window.mermaid !== 'undefined') ? 2 : 3;
        if (__mermaidState === 2) {
            // 原先在 app-ui.js 顶层执行的初始化，移到加载完成时（主题取当前值，与 applyTheme 一致）
            window.mermaid.initialize({
                startOnLoad: false,
                theme: currentTheme === 'dark' ? 'dark' : 'default',
                securityLevel: 'loose',
                fontFamily: 'var(--font-sans)',
            });
        }
        __mermaidFlush();
    };
    s.onerror = function () { __mermaidState = 3; __mermaidFlush(); };
    document.head.appendChild(s);
}

function __mermaidFlush() {
    var q = __mermaidQueue;
    __mermaidQueue = [];
    var m = (__mermaidState === 2) ? window.mermaid : null;
    for (var i = 0; i < q.length; i++) {
        try { q[i](m); } catch (e) { console.error('[mermaid] 回调异常', e); }
    }
}

function processMermaidBlocks(container) {
    if (!container) return;
    var blocks = container.querySelectorAll('pre code.language-mermaid:not([data-mermaid-processed])');
    if (blocks.length === 0) return;

    // 同步打标记：流式渲染会高频重入，避免同一批块被重复排队（加载失败时也不会无限重试）
    var pending = [];
    for (var i = 0; i < blocks.length; i++) {
        var codeEl = blocks[i];
        codeEl.setAttribute('data-mermaid-processed', 'true');
        if (codeEl.textContent.trim()) pending.push(codeEl);
    }
    if (pending.length === 0) return;

    __mermaidLoad(function (mermaid) {
        // 加载失败：保留原 <pre> 代码块，降级为纯文本展示（不做 DOM 替换）
        if (!mermaid || !mermaid.run) return;

        var nodes = [];
        for (var j = 0; j < pending.length; j++) {
            var codeEl = pending[j];
            var preEl = codeEl.parentNode;
            // 首次加载期间容器可能已被重渲染/移除，替换已脱离文档的节点会抛错
            if (!preEl || !preEl.parentNode) continue;

            var div = document.createElement('div');
            div.id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 8);
            div.className = 'mermaid-svg';
            div.style.cssText = 'text-align:center;padding:10px 0;overflow-x:auto;';
            div.textContent = codeEl.textContent.trim();
            preEl.parentNode.replaceChild(div, preEl);
            nodes.push(div);
        }

        if (nodes.length > 0) {
            mermaid.run({ nodes: nodes, suppressErrors: true }).catch(function () {});
        }
    });
}

function applyHljsTheme(theme) {
    var $lightLink = $('#hljs-light-theme');
    var $darkLink = $('#hljs-dark-theme');
    if (!$lightLink.length || !$darkLink.length) return;
    if (theme === 'dark') {
        $lightLink.prop('disabled', true).prop('media', 'not all');
        $darkLink.prop('disabled', false).prop('media', 'all');
    } else {
        $darkLink.prop('disabled', true).prop('media', 'not all');
        $lightLink.prop('disabled', false).prop('media', 'all');
    }
}

/* ===== Theme ===== */
// 首帧已由 index.html <body> 顶部的内联脚本按 localStorage 预置主题（防闪烁）；
// 这里再读一次作为常规初始化，与预置值一致，幂等。
var currentTheme = localStorage.getItem('chat-theme') || 'light';
$('body').attr('data-theme', currentTheme);
applyHljsTheme(currentTheme);

/* ===== Mermaid Init =====
   已移至 __mermaidLoad 的 onload 回调（按需加载后才初始化），此处不再预初始化。 */

// 启动时从后端同步主题（清空 localStorage 后仍能恢复）。
// 桌面端延后到后端就绪再拉，避免冷启动期占用连接；此前已由上面的 localStorage 值先行生效，无闪烁。
__whenBackendReady(function () {
    $.get('/web/settings/general', function(resp) {
        if (resp.code === 200 && resp.data && resp.data.darkMode != null) {
            applyTheme(resp.data.darkMode ? 'dark' : 'light');
        }
    });
});

function applyTheme(theme) {
    currentTheme = theme;
    $('body').attr('data-theme', theme);
    localStorage.setItem('chat-theme', theme);
    applyHljsTheme(theme);
    // 仅在 mermaid 已按需加载后才重设主题；未加载时不触发加载（加载后会读 currentTheme 自行初始化）
    if (__mermaidState === 2 && typeof window.mermaid !== 'undefined') {
        window.mermaid.initialize({ theme: theme === 'dark' ? 'dark' : 'default' });
    }
    // sync checkbox if settings panel is open
    var cb = document.getElementById('generalDarkMode');
    if (cb) cb.checked = (theme === 'dark');
}

// Init dark mode checkbox when settings opens
$(document).on('change', '#generalDarkMode', function() {
    var isDark = this.checked;
    applyTheme(isDark ? 'dark' : 'light');
    $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify({darkMode: isDark}), contentType: 'application/json', dataType: 'json' });
});

// Sync checkbox state when settings panel opens
$(document).on('click', '#settingsBtn', function() {
    setTimeout(function() {
        var cb = document.getElementById('generalDarkMode');
        if (cb) cb.checked = (currentTheme === 'dark');
    }, 50);
});

/* 「自动化 / 技能」均为独立主视图，不再走设置浮层 */
$(document).on('click', '#automationNavBtn', function() {
    if (typeof window.openAutomation === 'function') window.openAutomation();
});
$(document).on('click', '#skillsNavBtn', function() {
    if (typeof window.openSkills === 'function') window.openSkills();
});
$(document).on('click', '#channelNavBtn', function() {
    if (typeof window.openChannel === 'function') window.openChannel();
});
$(document).on('click', '#modelConfigNavBtn', function() {
    if (typeof window.openModelSettings === 'function') window.openModelSettings();
});

/* ===== View Switch ===== */
function switchToChatMode() {
    // 自动化视图占据主区时，即便 inChatMode 仍为 true 也必须走完整恢复流程，
    // 否则 chatView 拿不回 .active（防御未来又出现只改 DOM 不同步标志的入口）
    var fromAutomation = (typeof window.isAutomationOpen === 'function') && window.isAutomationOpen();
    var fromSkills = (typeof window.isSkillsOpen === 'function') && window.isSkillsOpen();
    var fromChannel = (typeof window.isChannelOpen === 'function') && window.isChannelOpen();
    var fromModelSettings = (typeof window.isModelSettingsOpen === 'function') && window.isModelSettingsOpen();
    if (typeof window.closeAutomation === 'function') window.closeAutomation();
    if (typeof window.closeSkills === 'function') window.closeSkills();
    if (typeof window.closeChannel === 'function') window.closeChannel();
    if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
    if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
    if (inChatMode && !fromAutomation && !fromSkills && !fromChannel && !fromModelSettings) return;
    inChatMode = true;
    $(welcomeView).hide();
    $(chatView).addClass('active');
    // 清除可能残留的加载按钮，避免旧会话的按钮在新视图里闪现
    if (messagesWrap) $(messagesWrap).find('.chat-load-more-wrapper').remove();
    chatInput.focus();
}
function switchToWelcomeMode() {
    if (typeof window.closeAutomation === 'function') window.closeAutomation();
    if (typeof window.closeSkills === 'function') window.closeSkills();
    if (typeof window.closeChannel === 'function') window.closeChannel();
    if (typeof window.closeModelSettings === 'function') window.closeModelSettings();
    if (typeof window.closeMemoryView === 'function') window.closeMemoryView();
    inChatMode = false;
    if (typeof forgetActiveSession === 'function') forgetActiveSession();
    SESSION_ID = (typeof newSessionId === 'function') ? newSessionId() : ('work-' + Date.now().toString(36));
    // 新会话落盘跟随工作空间选择（getSessionCwd→X-Session-Cwd）：选了工作空间即落该项目区。
    // 此时若历史视图停在「全局」，新会话发完首条消息不会出现在当前列表（全局视图只扫安装目录），
    // 须联动切回「项目」视图保证新建会话可见。无工作空间时视图恒为全局（effective 回退），无需处理。
    if (window.appMode !== 'code' && window.currentChatWorkspace
            && typeof effectiveHistoryScope === 'function'
            && effectiveHistoryScope() !== 'project'
            && typeof setHistoryScope === 'function') {
        setHistoryScope('project'); // 内部会重载列表，保证侧栏内容与视图一致
    }
    // 先把当前对话已选的模型/思考档位继承给新会话（写缓存），再激活，
    // 否则 setActiveSession→refreshSessionModel 会拉后端默认把选择冲掉。
    if (typeof inheritSelectionToSession === 'function') inheritSelectionToSession(SESSION_ID);
    setActiveSession(SESSION_ID);
    $(welcomeView).show();
    $(chatView).removeClass('active');
    welcomeInput.focus();
    // 新对话时禁用“历史消息”按钮
    $('#welcomeHistoryBtn').prop('disabled', true);
    // Reset model UI to new session
    if (typeof modelsLoaded !== 'undefined' && modelsLoaded) renderModelUI();
    // 切欢迎页时清空附件预览，避免跨视图残留
    if (typeof clearAttachmentPreview === 'function') clearAttachmentPreview();
}

/* ===== Auto-resize ===== */
$(welcomeInput).on('input', function() { autoResize(this); });
$(chatInput).on('input', function() { autoResize(this); });

/* ===== Input box height drag adjustment (top drag bar: min = current default height, max = 320px, double-click to restore) ===== */
var INPUT_RESIZE_MAX = 320;
function initInputResizeHandle(handle, textarea) {
    if (!handle || !textarea) return;
    var dragging = false, startY = 0, startH = 0;
    // The container has transition:all, and during dragging the outer frame lags 250ms behind the textarea's height, causing visual desync;
    // during dragging, temporarily disable the container's transition via .resizing (restored on mouseup).
    var box = textarea.closest('.input-box, .welcome-input-box, .git-commit-bar');
    handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        startY = e.clientY;
        startH = textarea.offsetHeight;
        handle.classList.add('dragging');
        if (box) box.classList.add('resizing');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        // Dragging upward (clientY decreases) increases the height
        var minH = parseFloat(getComputedStyle(textarea).minHeight) || textarea.offsetHeight;
        var h = Math.max(minH, Math.min(INPUT_RESIZE_MAX, startH + (startY - e.clientY)));
        textarea._manualH = h;
        textarea.style.height = h + 'px';
        // 解除 CSS max-height 限制（如 git 提交框 80px），双击恢复时清除内联 maxHeight 回 CSS 约束
        textarea.style.maxHeight = 'none';
    });
    document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        if (box) box.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
    handle.addEventListener('dblclick', function () {
        textarea._manualH = 0;
        textarea.style.maxHeight = '';
        autoResize(textarea);
    });
}
initInputResizeHandle(document.querySelector('.welcome-input-box .input-resize-handle'), welcomeInput);
initInputResizeHandle(document.querySelector('.input-box .input-resize-handle'), chatInput);
window.initInputResizeHandle = initInputResizeHandle;

/* ===== Voice Input (Web Speech API) - 按住说话（类似微信） ===== */
var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var recognition = null;
var voiceRecording = false;
var voiceTargetInput = null; // 当前语音目标 textarea
var voiceBaseText = '';      // 开始录音时 textarea 已有文本
var voiceFinalTranscript = ''; // 累计的最终识别文本

var welcomeVoiceBtn = $('#welcomeVoiceBtn');
var chatVoiceBtn = $('#chatVoiceBtn');

var voiceRafPending = false; // 限制 DOM 更新频率

function initVoice() {
    if (!SpeechRecognition) return; // 浏览器不支持
    // 桌面端（Electron）降级：Web Speech API 依赖 Chrome/Edge 内置的 Google 语音服务，
    // Electron（开源 Chromium）没有该服务端点，start() 必然失败。故桌面端不显示语音按钮。
    if (window.__GOURD_IPC__ && window.__GOURD_IPC__.isDesktop) return;
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true; // 按住期间持续识别
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = function(event) {
        var interimTranscript = '';
        var finalTranscript = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
            var transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        // 累积最终结果
        if (finalTranscript) {
            voiceFinalTranscript += finalTranscript;
        }
        // 用 RAF 节流 DOM 更新，避免频繁重绘拖慢感知
        if (!voiceRafPending && voiceTargetInput) {
            voiceRafPending = true;
            requestAnimationFrame(function() {
                voiceRafPending = false;
                if (voiceTargetInput) {
                    voiceTargetInput.value = voiceBaseText + voiceFinalTranscript + interimTranscript;
                    autoResize(voiceTargetInput);
                }
            });
        }
    };

    recognition.onerror = function(event) {
        // no-speech 和 aborted 是正常情况，不需要提示和停止
        if (event.error === 'no-speech' || event.error === 'aborted') {
            return;
        }

        stopVoiceRecording();

        if (event.error === 'not-allowed') {
            showToast(GourdI18n.t('ui.mic_permission_denied'), 'error');
        } else if (event.error === 'audio-capture') {
            showToast(GourdI18n.t('ui.mic_not_detected'), 'error');
        } else if (event.error === 'network') {
            showToast(GourdI18n.t('ui.voice_network_error'), 'error');
        } else {
            showToast(GourdI18n.t('ui.voice_error', [event.error]), 'error');
        }
    };

    recognition.onend = function() {
        // 如果还在按住状态（voiceRecording），自动重启继续识别
        if (voiceRecording) {
            try {
                recognition.start();
            } catch(e) {
                stopVoiceRecording();
            }
        } else {
            stopVoiceRecording();
        }
    };

    // 显示语音按钮
    welcomeVoiceBtn.removeClass('hidden');
    chatVoiceBtn.removeClass('hidden');
}

function startVoiceRecording(inputEl) {
    if (!recognition) return;
    if (voiceRecording) return;

    voiceTargetInput = inputEl;
    voiceBaseText = inputEl.value;
    voiceFinalTranscript = '';
    voiceRecording = true;

    // 强制停止旧实例，避免 InvalidStateError
    try {
        recognition.stop();
    } catch(e) {
        // 忽略停止错误
    }

    // 短暂延迟后启动，确保旧实例完全停止
    setTimeout(function() {
        if (!voiceRecording) return; // 用户已经松开了
        try {
            recognition.start();
        } catch(e) {
            voiceRecording = false;
            var btn = (inputEl === welcomeInput) ? welcomeVoiceBtn : chatVoiceBtn;
            btn.removeClass('recording');
            showToast(GourdI18n.t('ui.voice_start_failed', [e.message]), 'error');
        }
    }, 100);

    // 更新按钮状态
    var btn = (inputEl === welcomeInput) ? welcomeVoiceBtn : chatVoiceBtn;
    btn.addClass('recording');
    btn.prop('title', GourdI18n.t('ui.release_to_stop'));
}

function stopVoiceRecording() {
    if (!voiceRecording && !recognition) return;
    voiceRecording = false;
    try { if (recognition) recognition.stop(); } catch(e) {}

    // 更新按钮状态
    welcomeVoiceBtn.removeClass('recording');
    chatVoiceBtn.removeClass('recording');
    welcomeVoiceBtn.prop('title', GourdI18n.t('ui.hold_to_speak'));
    chatVoiceBtn.prop('title', GourdI18n.t('ui.hold_to_speak'));

    // 保留识别到的文本，重置基线以便下次追加
    if (voiceTargetInput) {
        voiceBaseText = voiceTargetInput.value;
    }
    voiceFinalTranscript = '';
    voiceTargetInput = null;
}

// --- 按住说话：按下开始录音，松开结束（类似微信） ---
function bindVoiceHold(btn, inputEl) {
    // 鼠标：按下开始，松开结束
    btn.on('mousedown', function(e) {
        e.preventDefault();
        startVoiceRecording(inputEl);
    });
    btn.on('mouseup', function(e) {
        e.preventDefault();
        stopVoiceRecording();
    });
    btn.on('mouseleave', function() {
        if (voiceRecording) stopVoiceRecording();
    });

    // 触摸：按下开始，松开结束
    btn.on('touchstart', function(e) {
        e.preventDefault();
        startVoiceRecording(inputEl);
    });
    btn.on('touchend', function(e) {
        e.preventDefault();
        stopVoiceRecording();
    });
    btn.on('touchcancel', function() {
        if (voiceRecording) stopVoiceRecording();
    });
}

bindVoiceHold(welcomeVoiceBtn, welcomeInput);
bindVoiceHold(chatVoiceBtn, chatInput);

initVoice();

/* ===== Sidebar Search Toggle ===== */
(function() {
    var sidebar = $('.sidebar');

    /* 侧边栏收起功能已移除：清理历史遗留的 collapsed 状态，避免老用户被卡在收起态（已无展开按钮）。 */
    sidebar.removeClass('collapsed');
    try { localStorage.removeItem('sidebar-collapsed'); } catch (e) {}

    var searchBtn = $('#filterListBtn');
    var searchBar = $('#sidebarSearchBar');
    var searchInput = $('#sidebarSearchInput');
    var searchClear = $('#sidebarSearchClear');
    var historyList = $('#historyList');

    /* 清空搜索时统一恢复各行可见性：会话/项目行恢复显示（清除 filter-hit 标记），
       .proj-sessions 仅清除内联样式（是否展示交还给展开态 CSS），小节标题与空态提示恢复显示。 */
    function restoreSidebarFilter() {
        historyList.find('.filter-hit').removeClass('filter-hit');
        historyList.find('.sidebar-item, .proj-node').show();
        historyList.find('.proj-sessions').css('display', '');
        historyList.find('.sidebar-section-title, .sidebar-empty-hint').show();
    }

    /* 过滤时同步小节标题：其下无可见条目时整体隐藏，避免只剩空壳。 */
    function syncHistoryFilterGroups() {
        historyList.find('.sidebar-section-title').each(function() {
            var $title = $(this);
            var hasVisible = false;
            var $el = $title.next();
            while ($el.length && !$el.hasClass('sidebar-section-title')) {
                if ($el.is(':visible')) { hasVisible = true; break; }
                $el = $el.next();
            }
            $title.toggle(hasVisible);
        });
    }

    if (searchBtn.length) {
        searchBtn.on('click', function() {
            var visible = searchBar.is(':visible');
            if (visible) {
                searchBar.hide();
                searchBtn.removeClass('active');
                searchInput.val('');
                searchClear.hide();
                // Restore full history list
                restoreSidebarFilter();
            } else {
                searchBar.show();
                searchBtn.addClass('active');
                searchInput.focus();
            }
        });
    }

    if (searchInput.length) {
        searchInput.on('input', function() {
            var val = this.value.toLowerCase().trim();
            searchClear.toggle(val.length > 0);
            if (val === '') {
                restoreSidebarFilter();
                return;
            }
            // 逐项按标签过滤（会话行），filter-hit 记录命中供分组统计
            historyList.find('.sidebar-item').each(function() {
                var label = $(this).find('.sidebar-item-label').text().toLowerCase();
                var hit = label.indexOf(val) >= 0;
                $(this).toggleClass('filter-hit', hit).toggle(hit);
            });
            // 项目文件夹行：文件夹名命中或子会话命中则显示；折叠的项目在搜索时也露出命中会话
            historyList.find('.proj-node').each(function() {
                var $node = $(this);
                var nameHit = $node.find('.proj-name').text().toLowerCase().indexOf(val) >= 0;
                var $group = $node.next('.proj-sessions');
                var hasHit = $group.length > 0 && $group.find('.sidebar-item.filter-hit').length > 0;
                if ($group.length) {
                    if (nameHit && !hasHit) {
                        // 文件夹名命中：展示其下全部会话
                        $group.find('.sidebar-item').addClass('filter-hit').show();
                        hasHit = true;
                    }
                    $group.toggle(hasHit);
                }
                $node.toggle(nameHit || hasHit);
            });
            // 过滤时隐藏空态提示；空分组的小节标题同步隐藏
            historyList.find('.sidebar-empty-hint').hide();
            syncHistoryFilterGroups();
        });
        // 列表重建（updateHistoryUI）后按当前关键字重新过滤，避免过滤态丢失
        window.reapplySidebarFilter = function() {
            if (searchBar.is(':visible')) searchInput.trigger('input');
        };
    }

    if (searchClear.length) {
        searchClear.on('click', function() {
            searchInput.val('').trigger('input').focus();
        });
    }
})();

/* ===== Sidebar Resize ===== */
(function() {
    var $sidebar = $('.sidebar');
    var $handle = $('#sidebarResizeHandle');

    if (!$handle.length || !$sidebar.length) return;

    var SIDEBAR_MIN_WIDTH = 180;
    var SIDEBAR_MAX_WIDTH = 600;

    // Init resize dragging
    (function initResize() {
        var isDragging = false;
        var startX = 0;
        var startWidth = 0;

        $handle.on('mousedown', function(e) {
            isDragging = true;
            startX = e.clientX;
            startWidth = $sidebar[0].offsetWidth;
            $handle.addClass('dragging');
            $(document.body).css({ cursor: 'col-resize', userSelect: 'none' });
            e.preventDefault();
        });

        $(document).on('mousemove', function(e) {
            if (!isDragging) return;
            var dx = e.clientX - startX;
            var newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + dx));
            $sidebar.css('width', newWidth + 'px');
            localStorage.setItem('sidebar-width', newWidth);
        });

        $(document).on('mouseup', function() {
            if (!isDragging) return;
            isDragging = false;
            $handle.removeClass('dragging');
            $(document.body).css({ cursor: '', userSelect: '' });
        });
    })();

    // Restore saved width
    (function restoreWidth() {
        var savedWidth = localStorage.getItem('sidebar-width');
        if (savedWidth) {
            var w = parseInt(savedWidth, 10);
            if (w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) {
                $sidebar.css('width', w + 'px');
            }
        }
    })();
})();

/* ===== Mobile Sidebar Drawer ===== */
(function() {
    var mobileMenuBtn = $('#mobileMenuBtn');
    var mobileOverlay = $('#mobileOverlay');
    var sidebar = $('.sidebar');
    if (!mobileMenuBtn.length || !sidebar.length) return;

    mobileMenuBtn.on('click', function() {
        sidebar.toggleClass('mobile-open');
        if (mobileOverlay.length) mobileOverlay.toggleClass('show');
    });

    if (mobileOverlay.length) {
        mobileOverlay.on('click', function() {
            sidebar.removeClass('mobile-open');
            mobileOverlay.removeClass('show');
        });
    }

    // Close sidebar when selecting a chat on mobile
    var sidebarList = $('.sidebar-list');
    if (sidebarList.length) {
        sidebarList.on('click', function(e) {
            var item = e.target.closest('.sidebar-item');
            if (item && window.innerWidth <= 768) {
                sidebar.removeClass('mobile-open');
                if (mobileOverlay.length) mobileOverlay.removeClass('show');
            }
        });
    }
})();

/* ===== Keyboard Shortcuts ===== */
$(document).on('keydown', function(e) {
    // Ctrl/Cmd + N: New chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        if (typeof newChatBtn !== 'undefined') newChatBtn.click();
    }
    // Ctrl/Cmd + K: 侧边栏搜索（搜索条已开则聚焦输入框，否则经 tab 行搜索图标展开）
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        var $bar = $('#sidebarSearchBar');
        if ($bar.is(':visible')) {
            $('#sidebarSearchInput').trigger('focus');
        } else {
            $('#filterListBtn').trigger('click');
        }
    }
    // Escape: close modals, lightbox
    if (e.key === 'Escape') {
        var $lightbox = $('.lightbox-overlay');
        if ($lightbox.length) $lightbox.remove();
    }
});

/* ===== 消息执行队列 UI ===== */
// 根据文件扩展名获取图标
function getFileIcon(fileName) {
    var ext = fileName.split('.').pop().toLowerCase();
    var iconMap = {
        'pdf': '📄', 'doc': '📝', 'docx': '📝', 'xls': '📊', 'xlsx': '📊',
        'ppt': '📽️', 'pptx': '📽️', 'zip': '📦', 'rar': '📦', '7z': '📦',
        'tar': '📦', 'gz': '📦', 'txt': '📃', 'csv': '📊', 'json': '📋',
        'xml': '📋', 'yaml': '⚙️', 'yml': '⚙️', 'md': '📑', 'java': '☕',
        'py': '🐍', 'js': '📜', 'ts': '📜', 'css': '🎨', 'html': '🌐',
        'c': '⚙️', 'cpp': '⚙️', 'h': '⚙️', 'go': '🔧', 'rs': '🦀',
        'sh': '💻', 'bat': '💻', 'ps1': '💻', 'sql': '🗄️', 'db': '🗄️'
    };
    return iconMap[ext] || '📎';
}

// ==================== 消息队列 UI 管理 ====================

// 全局队列处理状态
var _queueProcessing = {}; // { sessionId: boolean }

/* 输入框上方的 chip 容器（#chatTodoChipWrap）同时承载 todo chip 与 queue chip，
   二者任一可见即应显示该容器。由 app-todos.js 与本模块分别置位后统一汇算。 */
window._queueChipVisible = false;
function updateChipWrapVisibility() {
    var $wrap = $('#chatTodoChipWrap');
    if (!$wrap.length) return;
    var visible = !!window._queueChipVisible || !!window._todoChipVisible;
    $wrap.css('display', visible ? 'flex' : 'none');
}
window.updateChipWrapVisibility = updateChipWrapVisibility;

/* 更新队列 chip 按钮（#chatQueueChip）显隐与 badge 计数 */
function updateQueueChip(queue) {
    var $chip = $('#chatQueueChip');
    if (!$chip.length) return;
    var count = (queue && queue.length) || 0;
    var $badge = $('#queueBadge');
    if ($badge.length) {
        $badge.text(count);
        $badge.css('display', count > 0 ? '' : 'none');
    }
    $chip.css('display', count > 0 ? '' : 'none');
    window._queueChipVisible = count > 0;
    updateChipWrapVisibility();
}

async function updateMessageQueueUI() {
    if (!window.messageQueue) return;
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';

    try {
        var queue = await window.messageQueue.getQueue(sessionId);
        queue = queue || [];

        // chat 模式（对话视图）
        var $chatContainer = $('#message-queue-container');
        renderQueueContainer($chatContainer, '#message-queue-list', '#queue-count', queue, sessionId);

        // 欢迎页
        var $welcomeContainer = $('#welcome-message-queue-container');
        renderQueueContainer($welcomeContainer, '#welcome-message-queue-list', '#welcome-queue-count', queue, sessionId);

        // chip 按钮 + badge（队列与 todo 共享 #chatTodoChipWrap，任一有内容即显示）
        updateQueueChip(queue);
    } catch(e) {
        // 静默失败
    }
}

function renderQueueContainer($container, listSelector, countSelector, queue, sessionId) {
    if (!$container || !$container.length) return;
    if (!queue || queue.length === 0) {
        $container.hide();
    } else {
        // 悬浮面板模式下，仅渲染内容，不自动显示面板
        // 面板由用户点击 chip 触发显示
        var $list = $(listSelector);
        if ($list.length) {
            $list.empty();
            var isProcessing = _queueProcessing[sessionId] || false;

            queue.forEach(function(item, index) {
                var $item = $('<div>').addClass('queue-item').attr('data-index', index);

                if (isProcessing && index === 0) {
                    $item.addClass('processing');
                }

                var statusHtml = '';
                if (isProcessing && index === 0) {
                    // 处理中：绿色对勾（与 todo-done 一致）
                    statusHtml = '<span class="queue-item-status processing"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
                } else {
                    // 等待中：空心圆圈（与 todo-pending 一致）
                    statusHtml = '<span class="queue-item-status pending"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></span>';
                }

                var contentHtml = '';
                if (item.content) {
                    contentHtml += '<span class="queue-item-text">' + escapeHtml(item.content) + '</span>';
                }

                var imagePaths = item.imagePaths || [];
                var filePaths = item.filePaths || [];
                if (imagePaths.length > 0 || filePaths.length > 0) {
                    contentHtml += '<span class="queue-item-attachments">';
                    if (imagePaths.length > 0) {
                        contentHtml += '<span class="queue-attach-badge">图' + imagePaths.length + '</span>';
                    }
                    if (filePaths.length > 0) {
                        contentHtml += '<span class="queue-attach-badge">文件' + filePaths.length + '</span>';
                    }
                    contentHtml += '</span>';
                }

                $item.html(
                    '<span class="queue-item-index">' + (index + 1) + '</span>' +
                    contentHtml +
                    statusHtml +
                    (!isProcessing ? '<button class="queue-item-remove" title="移除">&times;</button>' : '')
                );

                if (!isProcessing) {
                    $item.find('.queue-item-remove').on('click', function() {
                        if (index === 0) {
                            window.messageQueue.shift(sessionId).then(function() {
                                updateMessageQueueUI();
                            });
                        } else {
                            showToast('请等待前面的消息发送后再移除', 'warning');
                        }
                    });
                }
                $list.append($item);
            });
        }
        var $count = $(countSelector);
        if ($count.length) $count.text(queue.length + ' 条');
    }
}

async function processMessageQueue(targetSessionId) {
    var sessionId = targetSessionId || activeSessionId || SESSION_ID || 'chat-default';

    if (!window.messageQueue) return;

    var total = await window.messageQueue.size(sessionId);
    if (total === 0) {
        updateMessageQueueUI();
        return;
    }

    _queueProcessing[sessionId] = true;
    try {
        await processNextQueuedMessage(sessionId);
    } finally {
        _queueProcessing[sessionId] = false;
        updateMessageQueueUI();
    }
}

async function processNextQueuedMessage(sessionId) {
    // 存在 busy 暂存消息时不再出队新消息：暂存消息会在当前任务 done 后自动补发，
    // 此时若再出队发送，服务端仍会返回 busy，导致暂存标记被覆盖、消息丢失
    var guardSess = sessionMap[sessionId];
    if (guardSess && guardSess._pendingResend) return;

    var item = await window.messageQueue.shift(sessionId);

    if (!item) {
        // 队列为空，结束
        return;
    }

    updateMessageQueueUI();

    // 设置输入框文本：按当前视图选择对应输入框（chatInput / welcomeInput）。
    // 此前用 $('#chat-input') 选择器命中不到任何元素（实际 id 为 chatInput），
    // 导致出队后 sendMessage 读到空输入直接 return，队列消息永远发不出去。
    var text = item.content || '';
    if (inChatMode) {
        if (chatInput) { chatInput.value = text; autoResize(chatInput); }
    } else {
        if (welcomeInput) { welcomeInput.value = text; autoResize(welcomeInput); }
    }

    // 发送消息
    sendMessage();

    // 等待发送完成
    await new Promise(function(resolve) {
        var checkInterval = setInterval(function() {
            if (!isStreaming) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
    });

    // 本条被 busy 暂存：停止本轮出队，等 done 后的自动补发链路接管（补发完成会再触发队列处理）
    var afterSess = sessionMap[sessionId];
    if (afterSess && afterSess._pendingResend) return;

    // 继续处理下一条
    var remainingAfter = await window.messageQueue.size(sessionId);
    if (remainingAfter > 0) {
        await processNextQueuedMessage(sessionId);
    }
}

// 清空队列按钮
$(document).on('click', '#queue-clear-btn', function() {
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';
    if (window.messageQueue && !_queueProcessing[sessionId]) {
        window.messageQueue.clear(sessionId).then(function() {
            updateMessageQueueUI();
        });
    }
});
$(document).on('click', '#welcome-queue-clear-btn', function() {
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';
    if (window.messageQueue && !_queueProcessing[sessionId]) {
        window.messageQueue.clear(sessionId).then(function() {
            updateMessageQueueUI();
        });
    }
});

/* 点击队列 chip：显示/隐藏队列面板，或折叠/展开列表 */
$(document).on('click', '#chatQueueChip', function(e) {
    e.stopPropagation();
    var $target = $('#message-queue-container');
    if (!$target.length) return;

    if ($target.is(':hidden')) {
        // 面板隐藏时，先关闭所有其他面板，再显示并展开
        if (typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels();
        $target.show().removeClass('collapsed');
    } else if ($target.hasClass('collapsed')) {
        // 面板显示但折叠时，展开
        $target.removeClass('collapsed');
    } else {
        // 面板显示且展开时，隐藏整个面板
        $target.hide();
    }
});

window.updateMessageQueueUI = updateMessageQueueUI;
window.processMessageQueue = processMessageQueue;

