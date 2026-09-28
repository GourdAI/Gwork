/* ===== 上下文用量进度环（输入框工具栏右区） =====
   旧实现是输入框上方一整行居中文本（.context-status），信息密度低却占满一行；
   现改为工具栏内 18px 进度环 + 悬停明细卡，并顺带展示后端一直在下发、旧界面却从未显示的
   inputTokens / outputTokens / cacheCreationTokens / messageCount。

   明细卡的「输入/输出」行有两个口径：
   - 新帧（args.totalInputTokens 非零）：显示会话累计消耗（全部轮次求和，含进行中 run），
     由后端 WebGate.emitToClient 在落盘前注入，历史回放无需重建；
     「消息条数」同步换为会话累计总条数（user + trace 帧计数，不受上下文压缩影响）。
   - 旧历史帧（无 totalInputTokens）：回退显示当轮口径，避免回放时明细卡突然丢行。

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
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
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
    // 会话累计口径（WebGate.emitToClient 注入，旧历史帧无此字段为 undefined）：
    // totalInputTokens/totalOutputTokens = 全部轮次累计消耗，totalMessages = 对话总条数
    var args = chunk.args || {};
    return {
        tokens: tokens,
        contextLength: contextLength,
        percent: percent,
        inputTokens: Math.round(chunk.inputTokens || 0),
        outputTokens: Math.round(chunk.outputTokens || 0),
        cacheRead: Math.round(chunk.cacheReadTokens || 0),
        cacheCreation: Math.round(chunk.cacheCreationTokens || 0),
        cacheRate: chunk.cacheRate,
        messageCount: isNaN(messageCount) ? 0 : messageCount,
        // 本轮订阅时刻（WebStreamBuilder.onContextUsageEvent 下发，与 trace.elapsedMs 同源）
        turnStartMs: Math.round(args.turnStartMs || 0),
        totalInputTokens: Math.round(args.totalInputTokens || 0),
        totalOutputTokens: Math.round(args.totalOutputTokens || 0),
        totalMessages: Math.round(args.totalMessages || 0),
        totalCacheCreation: Math.round(args.totalCacheCreation || 0),
        totalCacheRead: Math.round(args.totalCacheRead || 0)
    };
}

/**
 * 耗时格式化：与 app-message.js 的 fmtSec 同口径（&lt;1s / Ns / Mmin Ss），
 * 保证徒标与明细卡对同一轮给出一致的数字。
 * <p>本模块自带一份而非跨文件引用：app-context.js 需能独立加载/独立沙箱测试，
 * 且两份格式化器均为一行级纯函数，重复成本远低于耦合风险。</p>
 * @param {number} ms - 毫秒；非法/负值返回空串
 * @returns {string} 形如 "8s" / "<1s" / "1min 35s"
 */
function ctxFmtElapsed(ms) {
    if (!(typeof ms === 'number') || !(ms >= 0) || !isFinite(ms)) return '';
    var s = Math.round(ms / 1000);
    if (s < 1) return '<1s';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'min ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'min ' + (s % 60) + 's';
}

/**
 * 任务耗时行。值 span 带 {@code data-ctx-elapsed} 标记，供运行中 tick <b>定向更新</b>。
 * <p><b>为何不整卡重绘</b>：整卡重绘会重建整个悬停层 DOM，在 hover 期间造成闪烁
 * （以及用户正在选中数值时选区丢失）；只改一个 span 的 text 既不闪烁也不影响布局。</p>
 */
function ctxElapsedRow(text) {
    return '<div class="context-meter-row">'
        + '<span class="context-meter-label">' + ctxEsc(GourdI18n.t('context.task_elapsed')) + '</span>'
        + '<span class="context-meter-value" data-ctx-elapsed="1">' + ctxEsc(text) + '</span>'
        + '</div>';
}

/**
 * 把「服务器时钟下的本轮起点」换算成<b>客户端时钟下的等价时刻</b>。
 *
 * <p><b>为何必须换算</b>：{@code args.turnStartMs} 与 {@code createdAt} 都是<b>服务器</b>墙钟，
 * 而计时用的是<b>客户端</b> {@code Date.now()}。直接相减会把「两端时钟差」算成耗时
 * ——Web 远程部署下偏移可达数分钟，展示成“跑了 5min”而实际 3s；负偏移则算出负值，
 * 耗时行会被当成无效值整行消失。桌面版同机无此问题，但本控件同样跑在浏览器里，
 * 不能假设同机。</p>
 *
 * <p><b>校准原理</b>：{@code createdAt - turnStartMs} 两个量同属服务器时钟，其差
 * （= 帧生成时本轮已走的耗时）与两端偏移无关；用客户端当前时刻减掉它，即得本轮起点
 * 在客户端时钟下的等价时刻。</p>
 *
 * <p><b>无法校准时退回原值</b>：旧帧没有 {@code createdAt}（或异常小于起点）时返回
 * 原始 {@code turnStartMs}，保持与改动前一致的行为，不臆造。</p>
 *
 * @param {Object} chunk - context_size 帧
 * @param {Object} m - {@link buildContextModel} 归一后的展示模型
 * @returns {number} 客户端时钟下的本轮起点；无起点时返回 0
 */
function ctxLocalTurnAnchor(chunk, m) {
    if (!(m.turnStartMs > 0)) return 0;
    var createdAt = (chunk && typeof chunk.createdAt === 'number') ? chunk.createdAt : 0;
    if (createdAt <= m.turnStartMs) return m.turnStartMs;
    return Date.now() - (createdAt - m.turnStartMs);
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
 * @param {Object} [opts] - 可选：{@code elapsedMs} = 已定格的权威耗时（来自 trace 帧）；
 *        {@code live} = 是否处于运行中（仅此时才按 turnStartMs 实时推算）
 * @returns {string} 明细卡 HTML
 */
function buildContextRows(chunk, opts) {
    var m = buildContextModel(chunk);
    opts = opts || {};
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

    // 累计口径优先（用户拍板：直接替换本轮两行）：新帧有 args.totalInputTokens 时展示
    // 「累计输入/累计输出/消息条数（会话累计）」；旧历史帧无此字段则回退当轮口径，
    // 避免回放时明细卡突然丢行。累计为 0 的旧会话首帧同样回退（后端注入门槛：非零才注入）。
    if (m.totalInputTokens > 0 || m.totalOutputTokens > 0) {
        html += ctxRow(GourdI18n.t('context.total_input'), ctxFmtK(m.totalInputTokens), true);
        html += ctxRow(GourdI18n.t('context.total_output'), ctxFmtK(m.totalOutputTokens));
        if (m.totalCacheCreation > 0) {
            html += ctxRow(GourdI18n.t('context.total_cache_creation'), ctxFmtK(m.totalCacheCreation));
        }
        if (m.totalCacheRead > 0) {
            html += ctxRow(GourdI18n.t('context.total_cache_read'), ctxFmtK(m.totalCacheRead));
        }
        if (m.totalMessages > 0) {
            html += ctxRow(GourdI18n.t('context.messages'), String(m.totalMessages));
        }
    } else {
        html += ctxRow(GourdI18n.t('context.turn_input'), ctxFmtK(m.inputTokens), true);
        html += ctxRow(GourdI18n.t('context.turn_output'), ctxFmtK(m.outputTokens));
        if (m.messageCount > 0) {
            html += ctxRow(GourdI18n.t('context.messages'), String(m.messageCount));
        }
    }

    // 任务耗时（末行）。三种取值按优先级：
    //   1) 已定格的权威值（trace 帧的 elapsedMs）；
    //   2) 运行中（live）按本轮起点实时推算，由 tick 每秒刷新；
    //   3) 两者均无（典型是历史回放：context_size 帧带 turnStartMs 但 run 早已结束）
    //      —— <b>整行省略</b>。此处绝不能回退到实时推算：回放时 turnStartMs 是历史时刻，
    //      Date.now() 减它会得到一个持续暴涨的计时器（已结束的会话看起来“跑了几天”）。
    var elapsedTxt = '';
    if (typeof opts.elapsedMs === 'number' && opts.elapsedMs >= 0) {
        elapsedTxt = ctxFmtElapsed(opts.elapsedMs);
    } else if (opts.live && m.turnStartMs > 0) {
        // 必须走 ctxLocalTurnAnchor 校准：直接 Date.now()-turnStartMs 会把时钟偏移算成耗时
        elapsedTxt = ctxFmtElapsed(Date.now() - ctxLocalTurnAnchor(chunk, m));
    }
    if (elapsedTxt) {
        html += ctxElapsedRow(elapsedTxt);
    }
    return html;
}

/* ===== 任务耗时实时展示（明细卡末行） =====
   数据源两个，按优先级取用：
   ① trace 帧的 elapsedMs（轮次收口后的权威值，TurnTimer 用单调时钟测得）；
   ② context_size 帧的 args.turnStartMs（本轮订阅时刻，与 ① 同源）+ 前端 tick。
   两者同源故不会出现「环上 12s、徒标 14s」的矛盾态（TurnTimer 注释里点名的坑）。

   状态挂在会话对象上（指示器是全局单例 DOM，必须按会话回填）：
   _ctxElapsedMs      已定格的权威耗时（属于 _ctxElapsedForTurn 那一轮）
   _ctxElapsedForTurn 定格值对应的 turnStartMs，用于新轮自动作废
   _ctxElapsedTimer   tick 句柄 */

/** 当前正在 tick 的会话（单例 DOM 同一时刻只应有一个计时器）。 */
var _ctxTickingSess = null;

/**
 * 该会话的任务是否「仍在跑」。
 * <p><b>挂起（ask_user / HITL）算在跑</b>：此时 isStreaming 已被 done 置 false，
 * 但引擎只是等用户拍板，恢复后带<b>同一个 runId</b> 继续跑（见 finishStream 的
 * {@code _runSuspended}）。只认 isStreaming 会让耗时行在问答卡弹出时突然消失。</p>
 * <p><b>回放不算在跑</b>：{@code _replaying} 是纯历史重建，帧里的 turnStartMs 是
 * 历史时刻，拿它减 Date.now() 会得到一个持续暴涨的计时器。</p>
 */
function isContextRunLive(sess) {
    if (!sess) return false;
    if (sess._replaying) return false;
    return !!(sess.isStreaming || sess._runSuspended);
}

/** 停止耗时 tick（幂等）。 */
function stopContextElapsedTick() {
    if (_ctxTickingSess && _ctxTickingSess._ctxElapsedTimer) {
        clearInterval(_ctxTickingSess._ctxElapsedTimer);
        _ctxTickingSess._ctxElapsedTimer = null;
    }
    _ctxTickingSess = null;
}

/**
 * 取本轮的已定格耗时；新轮开始时自动作废旧值。
 *
 * <p>以 {@code turnStartMs} 为轮身份判据：新一轮的起点必然不同，因此无需侵入
 * 发送链路去清理，渲染时自然失效（幂等：同一帧反复渲染不会反复清）。</p>
 *
 * <p><b>为何要「迟到绑定」而不是严格要求先有 context_size 帧</b>：定格发生在 trace 帧，
 * 而轮身份取自 context_size 帧的 {@code turnStartMs}。生产中前者必然后于后者到达，
 * 但若把正确性绑在帧到达顺序上，任何一处重排（新增事件、回放、异常提前收口）都会
 * 让定格值被静默作废。故 marker 未知（=0）时用当前帧的起点补上身份，
 * 使结果与顺序无关；只有「已知且不同」才判定为跨轮并作废。</p>
 */
function settledContextElapsed(sess, m) {
    if (!sess || typeof sess._ctxElapsedMs !== 'number') return undefined;
    if (m.turnStartMs > 0) {
        var marker = sess._ctxElapsedForTurn || 0;
        if (marker === 0) {
            sess._ctxElapsedForTurn = m.turnStartMs;   // 迟到绑定
        } else if (marker !== m.turnStartMs) {
            sess._ctxElapsedMs = undefined;            // 跨轮：旧定格值作废
            sess._ctxElapsedForTurn = undefined;
            return undefined;
        }
    }
    return sess._ctxElapsedMs;
}

/**
 * 把展示模型渲染到进度环 DOM（唯一写 DOM 的入口，三个恢复/更新路径共用）。
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 * @param {Object} [sess] - 所属会话；传入时启用耗时行（运行中 tick / 收口定格）
 */
function renderContextMeter(chunk, sess) {
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
    var live = isContextRunLive(sess);
    $meter.find('.context-meter-pop-body').html(buildContextRows(chunk, {
        elapsedMs: settledContextElapsed(sess, m),
        live: live
    }));
    $meter.css('display', '');

    syncContextElapsedTick(chunk, sess, m, live);
}

/**
 * 同步耗时 tick：仅在「前台会话 + 运行中 + 尚未定格 + 有起点」时保持一个计时器。
 * <p><b>不整卡重绘</b>：tick 只改写 {@code [data-ctx-elapsed]} 那个 span 的 text。
 * 整卡重绘会在 hover 期间闪烁，并丢掉用户正在选中的数值。</p>
 * <p><b>前台门禁放在创建时而非靠 tick 自毁</b>：单例 DOM 只服务前台会话，给后台会话
 * 建计时器既是浪费也会误写陈旧卡面；但也不能顺手停掉别人——否则后台会话一渲染
 * 就把前台正在跑的计时器误杀，耗时行冻结在旧值。</p>
 */
function syncContextElapsedTick(chunk, sess, m, live) {
    var foreground = (typeof activeSessionId === 'undefined')
        || (sess && sess.sessionId === activeSessionId);
    if (!foreground) return;   // 不建，也不误停前台会话的 tick

    var wantTick = !!(sess && live && typeof settledContextElapsed(sess, m) !== 'number' && m.turnStartMs > 0);
    if (!wantTick) {
        stopContextElapsedTick();
        return;
    }
    // 同一会话已在 tick 且起点未变：沿用现有计时器（避免每帧重建定时器）
    if (_ctxTickingSess === sess && sess._ctxElapsedTimer) return;

    stopContextElapsedTick();
    _ctxTickingSess = sess;

    // 锚点在创建时固化一次：与初次渲染同一口径（ctxLocalTurnAnchor），且不会因
    // 后续帧反复重建定时器而把表“拉回去”。客户端与服务器时钟偏移已在校准里消除。
    var localAnchor = ctxLocalTurnAnchor(chunk, m);

    sess._ctxElapsedTimer = setInterval(function () {
        // 三重自毁门禁：会话切走 / 已定格 / DOM 已不在（均不得给后台会话或陈旧卡面写数）
        var foreground = (typeof activeSessionId === 'undefined') || sess.sessionId === activeSessionId;
        if (!foreground || typeof sess._ctxElapsedMs === 'number') {
            stopContextElapsedTick();
            return;
        }
        var $span = $('.context-meter').find('[data-ctx-elapsed]');
        if (!$span.length) { stopContextElapsedTick(); return; }
        $span.text(ctxFmtElapsed(Date.now() - localAnchor));
    }, 1000);
}

/**
 * 轮次收口：用 trace 帧的权威 elapsedMs 定格耗时行（与徒标同源同值）。
 * <p>由 app-streaming.js 的 {@code case 'trace'} 调用。无耗时字段（旧历史帧）时静默返回，
 * 不得用 0 或推算值顶替。</p>
 * @param {Object} sess - 所属会话
 * @param {number} elapsedMs - trace 帧携带的本轮耗时（毫秒）
 */
function settleContextElapsed(sess, elapsedMs) {
    if (!sess) return;
    if (typeof elapsedMs !== 'number' || !(elapsedMs >= 0) || !isFinite(elapsedMs)) return;
    sess._ctxElapsedMs = elapsedMs;
    sess._ctxElapsedForTurn = buildContextModel(sess.lastContextChunk || {}).turnStartMs || 0;
    // 只停「正在为这个会话走表」的计时器。_ctxTickingSess 是<b>全局单例</b>，
    // 若无条件停表，后台会话的 trace 帧会把前台会话正在走的表误杀
    // （表现：当前对话的耗时行冻结在旧值不再前进，直到下一个 context_size 帧才复活）。
    if (_ctxTickingSess === sess) {
        stopContextElapsedTick();
    }
    // 仅当前台会话才重绘（单例 DOM）；后台会话留待切回时由 restore 路径渲染
    if (typeof activeSessionId === 'undefined' || sess.sessionId === activeSessionId) {
        if (sess.lastContextChunk) renderContextMeter(sess.lastContextChunk, sess);
    }
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

    renderContextMeter(chunk, sess);
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
        renderContextMeter(sess.lastContextChunk, sess);
        return;
    }

    stopContextElapsedTick();
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

    // 仅当该会话正在前台展示时才重绘（指示器是全局单例 DOM）。
    // 必须传 sess：否则重绘会丢失任务耗时行（拿不到定格值与 live 门禁）并停掉 tick。
    if (typeof activeSessionId === 'undefined' || sess.sessionId === activeSessionId) {
        renderContextMeter(chunk, sess);
    }
}

/* 思考/等待指示器已迁回消息区（thinking-row / inline-thinking），由 app-message.js 统一管理。 */
