/* ===== 上下文用量进度环（输入框工具栏右区） =====
   旧实现是输入框上方一整行居中文本（.context-status），信息密度低却占满一行；
   现改为工具栏内 18px 进度环 + 悬停明细卡，并顺带展示后端一直在下发、旧界面却从未显示的
   inputTokens / outputTokens / cacheCreationTokens / messageCount。

   对外接口保持不变（updateContextIndicator / restoreContextIndicator / resetContextIndicator），
   调用方 app-streaming.js 与 app-base.js 无需改动。 */

/** 环周长 = 2πr（r=8，保留 2 位）。必须与 CSS .context-meter-fill 的 stroke-dasharray 严格一致，
 *  否则进度条会出现「100% 仍留缺口」或「未满就绕满圈」。 */
var CONTEXT_RING_CIRCUMFERENCE = 50.27;
/** 占用率分色阈值：达到即从常规色切到警告/危险色，并让百分比数字现身。 */
var CONTEXT_WARN_PERCENT = 60;
var CONTEXT_CRIT_PERCENT = 85;

/**
 * 数值格式化：大数转 k/m 简写
 */
function ctxFmtK(n) {
    if (n >= 1000000 && n % 1000000 === 0) return (n / 1000000) + 'm';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return n.toString();
}

/**
 * 缓存命中率格式化（与 trace 行共用，避免两处精度口径漂移）。
 * <p>后端保留 2 位小数，展示层收敛到 1 位；不足 0.1% 时用 "<0.1%" 表达，
 * 避免四舍五入后出现无意义的 "0.0%"。</p>
 * @param {number} rate - 命中率百分比（0~100）
 * @returns {string} 形如 "87.3%" / "<0.1%"；无效或为 0 时返回空串
 */
function fmtCacheRate(rate) {
    if (typeof rate !== 'number' || !(rate > 0)) return '';
    if (rate < 0.1) return '<0.1%';
    return (Math.round(rate * 10) / 10).toFixed(1) + '%';
}

/** HTML 转义（明细卡用 innerHTML 注入，文案来自 i18n，需与其它模块同口径转义）。 */
function ctxEsc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
}

/**
 * 从 context_size chunk 抽取展示模型（纯函数，无副作用、无 DOM 依赖）。
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 * @returns {Object} 归一后的展示数据
 */
function buildContextModel(chunk) {
    chunk = chunk || {};
    var tokens = Math.round(chunk.totalTokens || 0);
    var contextLength = 0;
    if (chunk.args && chunk.args.contextLength) {
        contextLength = Math.round(chunk.args.contextLength);
    }
    // 分母缺失时不臆造占用率：环留空，明细里仍能看到绝对量
    var percent = contextLength > 0 ? Math.round(tokens / contextLength * 100) : 0;
    // messageCount 由后端放在 text 字段（WebStreamBuilder.onContextUsageEvent）
    var messageCount = parseInt(chunk.text, 10);
    return {
        tokens: tokens,
        contextLength: contextLength,
        percent: percent,
        inputTokens: Math.round(chunk.inputTokens || 0),
        outputTokens: Math.round(chunk.outputTokens || 0),
        cacheRead: Math.round(chunk.cacheReadTokens || 0),
        cacheCreation: Math.round(chunk.cacheCreationTokens || 0),
        cacheRate: chunk.cacheRate,
        messageCount: isNaN(messageCount) ? 0 : messageCount
    };
}

/** 明细卡单行。 */
function ctxRow(label, value, isSep) {
    return '<div class="context-meter-row' + (isSep ? ' is-sep' : '') + '">'
        + '<span class="context-meter-label">' + ctxEsc(label) + '</span>'
        + '<span class="context-meter-value">' + ctxEsc(value) + '</span>'
        + '</div>';
}

/**
 * 构建悬停明细卡内容（纯函数）。
 * <p>取值为 0 的可选指标（缓存读取/写入）整行省略，避免一屏全是 0 的噪声；
 * 「已用 / 占用率」两行恒在，是这个控件的主语义。</p>
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 * @returns {string} 明细卡 HTML
 */
function buildContextRows(chunk) {
    var m = buildContextModel(chunk);
    var html = ctxRow(GourdI18n.t('context.used'),
            ctxFmtK(m.tokens) + ' / ' + (m.contextLength > 0 ? ctxFmtK(m.contextLength) : '--'));
    html += ctxRow(GourdI18n.t('context.percent'), m.contextLength > 0 ? m.percent + '%' : '--');

    if (m.cacheRead > 0) {
        var rateTxt = fmtCacheRate(m.cacheRate);
        html += ctxRow(GourdI18n.t('context.cache_read'),
                ctxFmtK(m.cacheRead) + (rateTxt ? ' (' + rateTxt + ')' : ''));
    }
    if (m.cacheCreation > 0) {
        html += ctxRow(GourdI18n.t('context.cache_write'), ctxFmtK(m.cacheCreation));
    }

    html += ctxRow(GourdI18n.t('context.turn_input'), ctxFmtK(m.inputTokens), true);
    html += ctxRow(GourdI18n.t('context.turn_output'), ctxFmtK(m.outputTokens));
    if (m.messageCount > 0) {
        html += ctxRow(GourdI18n.t('context.messages'), String(m.messageCount));
    }
    return html;
}

/**
 * 把展示模型渲染到进度环 DOM（唯一写 DOM 的入口，两个恢复/更新路径共用）。
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 */
function renderContextMeter(chunk) {
    var $meter = $('.context-meter');
    if (!$meter.length) return;

    var m = buildContextModel(chunk);
    // 环长度按 0~100 夹取：超窗（>100%）时画满整圈而非绕回去，负值/NaN 归零
    var pct = Math.max(0, Math.min(100, m.percent || 0));
    var offset = Math.round(CONTEXT_RING_CIRCUMFERENCE * (1 - pct / 100) * 100) / 100;
    $meter.find('.context-meter-fill').attr('stroke-dashoffset', String(offset));

    $meter.removeClass('is-warn is-crit');
    if (m.percent >= CONTEXT_CRIT_PERCENT) $meter.addClass('is-crit');
    else if (m.percent >= CONTEXT_WARN_PERCENT) $meter.addClass('is-warn');

    $meter.find('.context-meter-pct').text(m.percent + '%');
    $meter.find('.context-meter-pop-body').html(buildContextRows(chunk));
    $meter.css('display', '');
}

/**
 * 更新上下文状态 UI
 * @param {Object} chunk - type 为 context_size 的 WebChunk（真实用量：推理后依据模型 usage 生成）
 * @param {Object} [sess] - 所属会话；传入时把用量快照挂到会话上，切走再切回可原样恢复
 */
function updateContextIndicator(chunk, sess) {
    // 单调时间戳门禁：旧帧不得回退新帧。
    // 必要性——context_size 会落盘并参与历史回放，「加载更多」(prepend) 会重放更早的事件，
    // 若无此门禁，指示器会被历史早期的小数值覆盖，且错值会写进 sess.lastContextChunk 长期污染。
    if (sess && sess.lastContextChunk
            && (chunk.createdAt || 0) < (sess.lastContextChunk.createdAt || 0)) {
        return;
    }
    // 快照存到会话对象：切会话不再丢失缓存指标（指示器是全局单例 DOM，必须按会话回填）
    if (sess) sess.lastContextChunk = chunk;

    renderContextMeter(chunk);
}

/**
 * 按会话恢复上下文状态指示器（切换会话时调用）。
 * <p>该会话有历史用量快照则原样回填，否则整体隐藏。</p>
 * <p>无数据时<b>隐藏而非显示空环</b>：空环会被读成「上下文占用 0%」，而真实语义是「本会话还没有任何用量数据」。</p>
 * @param {Object} [sess] - 目标会话对象（缺省则仅做清空）
 */
function restoreContextIndicator(sess) {
    var $meter = $('.context-meter');
    if (!$meter.length) return;

    if (sess && sess.lastContextChunk) {
        renderContextMeter(sess.lastContextChunk);
        return;
    }

    $meter.hide();
    $meter.removeClass('is-warn is-crit');
    $meter.find('.context-meter-fill').attr('stroke-dashoffset', String(CONTEXT_RING_CIRCUMFERENCE));
    $meter.find('.context-meter-pct').text('');
    $meter.find('.context-meter-pop-body').empty();
}

/**
 * 重置上下文状态指示器（无可恢复会话时的清空入口）
 */
function resetContextIndicator() {
    restoreContextIndicator(null);
}

/**
 * 切换上下文窗口后立即按新分母重算占用率。
 *
 * <p><b>为什么必须有这个入口</b>：进度环的分母来自 {@code chunk.args.contextLength}（随用量帧下发），
 * 而用户在模型下拉里改窗口是纯前端动作。不同步就会出现「按钮已显 1M、环还按 256K 算」
 * 的矛盾态（甚至停在红色告警），直到下一轮用量帧到达才自愈。</p>
 *
 * <p>只改写快照里的分母，不碰 token 绝对量：后者是模型上报的真实用量，与窗口选择无关。</p>
 *
 * @param {Object} [sess] - 目标会话；无会话或无快照时静默返回
 * @param {number} contextLength - 新的上下文窗口大小
 */
function applyContextLength(sess, contextLength) {
    if (!sess || !sess.lastContextChunk) return;
    if (!(contextLength > 0)) return;

    var chunk = sess.lastContextChunk;
    if (!chunk.args) chunk.args = {};
    chunk.args.contextLength = contextLength;

    // 仅当该会话正在前台展示时才重绘（指示器是全局单例 DOM）
    if (typeof activeSessionId === 'undefined' || sess.sessionId === activeSessionId) {
        renderContextMeter(chunk);
    }
}

/* 思考/等待指示器已迁回消息区（thinking-row / inline-thinking），由 app-message.js 统一管理。 */
