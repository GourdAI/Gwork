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
        totalCacheRead: Math.round(args.totalCacheRead || 0),
        // 输出速度（TPS）：Rust 内核把本轮累计「解码时长 / 解码 token」注入 context_size 帧的
        // args（与累计用量同源、同样参与历史回放与 createdAt 单调门禁）。旧帧无此字段时为 0，
        // 该行整行省略，不拿 outputTokens ÷ elapsedMs 顶替（口径不同，会伪装成同一个指标）。
        generationMs: Math.round(args.generationMs || 0),
        generatedTokens: Math.round(args.generatedTokens || 0),
        // 首 Token 延迟（TTFT）：内核用 run 级 latch 测得「起点 → 首个可见输出」，同样注入 args。
        // 用 hasOwnProperty 判存在而非判真值：合法的 0ms 首字与「本轮根本没有可见输出」是两回事
        // （对齐 Java TurnTimer.finish：无可见输出时 ttftMs 为 null，绝不下发 0）。
        ttftMs: Object.prototype.hasOwnProperty.call(args, 'ttftMs') && args.ttftMs != null
            ? Math.round(args.ttftMs) : null
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

/**
 * 输出速度（TPS）文本。原先尾部 trace 弹层的 traceTpsText 已移除，这里是唯一实现。
 * <p>本模块自带一份而非跨文件引用：app-context.js 需能独立加载/独立沙箱测试，
 * 且两者都是一行级纯函数，重复成本远低于耦合风险（同 ctxFmtElapsed 的取舍）。</p>
 * <p>分母是内核累计的【解码段时长】、分子是【同一批解码段产出的 token】，
 * 不含工具执行/审批等待；缺任一字段或非正数时返回空串让该行整行省略。</p>
 * @param {Object} m - buildContextModel 归一后的展示模型
 * @returns {string} 形如 "80 tokens/s"；无数据时空串
 */
function ctxTpsText(m) {
    if (!(m.generatedTokens > 0) || !(m.generationMs > 0)) return '';
    var tps = m.generatedTokens / (m.generationMs / 1000);
    if (!isFinite(tps) || !(tps > 0)) return '';
    var num = tps >= 100 ? Math.round(tps) : Math.round(tps * 10) / 10;
    return GourdI18n.t('chat.tps_unit').replace('{n}', num);
}

/**
 * 首 Token 延迟文本（不足 1 秒用 ms，否则用 2 位小数的秒）。
 * <p>口径与原 trace 弹层一致，复用 chat.ttft（12 语言包已有译文）。
 * 旧历史帧无 args.ttftMs 时为 null，该行整行省略而非显示 0。</p>
 * @param {Object} m - buildContextModel 归一后的展示模型
 * @returns {string} 形如 "860ms" / "5.39s"；无数据时空串
 */
function ctxTtftText(m) {
    if (typeof m.ttftMs !== 'number' || !(m.ttftMs >= 0) || !isFinite(m.ttftMs)) return '';
    var ms = m.ttftMs;
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (Math.round(ms / 10) / 100).toFixed(2) + 's';
}

/** 明细卡单行。 */
function ctxRow(label, value, isSep) {
    return '<div class="context-meter-row' + (isSep ? ' is-sep' : '') + '">'
        + '<span class="context-meter-label">' + ctxEsc(label) + '</span>'
        + '<span class="context-meter-value">' + ctxEsc(value) + '</span>'
        + '</div>';
}

/** 行节点上留存的原始数值：非法/缺失一律归零，绝不把 NaN/Infinity 写进属性。 */
function ctxRowNum(v) {
    var n = Math.round(Number(v) || 0);
    return isFinite(n) && n > 0 ? n : 0;
}

/**
 * 输出速度行。值 span 带 {@code data-ctx-tps} 供实时帧定向改字；
 * {@code data-ctx-tps-n / data-ctx-tps-ms} 存原始数值，供语言切换时重算
 * （ctxTpsText 把 {@code t('chat.tps_unit')} 写死进文本节点，translateDOM 的静态 key 扫描扫不到）。
 * <p>结构与 {@link ctxRow} 完全一致：同一组 class，不引入新 DOM 层级。</p>
 */
function ctxTpsRow(text, metrics) {
    metrics = metrics || {};
    return '<div class="context-meter-row">'
        + '<span class="context-meter-label" data-ctx-tps-label="1">' + ctxEsc(GourdI18n.t('chat.output_tps')) + '</span>'
        + '<span class="context-meter-value" data-ctx-tps="1"'
        + ' data-ctx-tps-n="' + ctxRowNum(metrics.generatedTokens) + '"'
        + ' data-ctx-tps-ms="' + ctxRowNum(metrics.generationMs) + '">'
        + ctxEsc(text) + '</span>'
        + '</div>';
}

/** 首 Token 延迟行。值 span 带 {@code data-ctx-ttft} 供实时帧定向改字（文案无参数，不需重译）。 */
function ctxTtftRow(text) {
    return '<div class="context-meter-row">'
        + '<span class="context-meter-label" data-ctx-ttft-label="1">' + ctxEsc(GourdI18n.t('chat.ttft')) + '</span>'
        + '<span class="context-meter-value" data-ctx-ttft="1">' + ctxEsc(text) + '</span>'
        + '</div>';
}

/**
 * 构建悬停明细卡内容（纯函数）。
 * <p>取值为 0 的可选指标（缓存读取/写入）整行省略，避免一屏全是 0 的噪声；
 * 「已用 / 占用率」两行恒在，是这个控件的主语义。</p>
 * @param {Object} chunk - type 为 context_size 的 WebChunk
 * @param {Object} [opts] - 可选：{@code elapsedMs} = 已定格的权威耗时（来自 trace 帧）；
 *        {@code live} = 是否处于运行中（仅此时才按 turnStartMs 实时推算）；
 *        {@code liveMetrics} = 会话上暂存的实时滑窗速率 / TTFT（来自 tps_progress 帧）。
 *        语义：整卡重绘时回填实时值，避免把 hover 卡面抹回上一轮结算值；
 *        结算帧的 context_size 会先清掉该态，故此处出现即代表「尚未结算」。
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
    // 输出速度 / 首 Token 延迟：与累计用量同源（都来自 context_size.args），
    // 一起放在用量行之后、任务耗时之前。TPS、TTFT 与总用时原本挤在尾部 hover 弹层里，
    // 用户要求收进这张卡并删掉弹层；复用 chat.* 既有译文，不新增 i18n 键。
    // 若会话上还挂着未结算的实时值（tps_progress 帧），整卡重绘时优先回填它：
    // 否则 noteContextTurnStart / settleContextElapsed / restore 等重绘会把卡面抹回
    // 上一轮的结算值，直到下一个 500ms 速率帧才恢复。结算帧抵达时 updateContextIndicator
    // 会先清掉 _ctxLive，故这里的优先级天然让位给权威累计值。
    var liveMetrics = (opts.liveMetrics && typeof opts.liveMetrics === 'object') ? opts.liveMetrics : null;
    var tpsTxt = ctxTpsText(m);
    if (liveMetrics) {
        // 滑窗实测口径：首字帧 (0,0) 或无速率窗口显示 '--'，不拿旧帧的结算速率顶替。
        html += ctxTpsRow(ctxTpsText(liveMetrics) || '--', liveMetrics);
    } else if (tpsTxt) {
        html += ctxTpsRow(tpsTxt, m);
    }
    var ttftTxt = ctxTtftText(m);
    if (liveMetrics) {
        // 首字帧未锁存 TTFT 时显示 '--'（内核锁存后每帧都带值，下一帧定向补上）。
        // 绝不回退到 chunk 里的旧结算值：那属于上一轮，实时窗口不能串值。
        html += ctxTtftRow(ctxTtftText(liveMetrics) || '--');
    } else if (ttftTxt) {
        html += ctxTtftRow(ttftTxt);
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
        live: live,
        // 整卡重绘时回填未结算的滑窗实测值；结算帧抵达前 updateContextIndicator 已清掉
        // _ctxLive，故此处出现即代表「本次不是结算覆盖」。
        liveMetrics: sess && sess._ctxLive
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

/* ===== 实时 TPS / TTFT（tps_progress 瞬态帧） =====
    内核在模型流式输出期间每 ≥500ms 发一帧 {generationMs, generatedTokens, ttftMs, live:true}：
    首字帧 (0,0) 只锁存 TTFT，之后每帧是一个真实测量窗口。注意这里分子是【delta 数】、
    结算帧 args 的分子是 provider 上报的【token 数】，单位不同，故结束时数值跳变属预期。
    模型调用结算时改发 context_size，其 args 是权威累计值并覆盖实时值。

    四条硬约束：
    ① 该帧刻意不带 phase、不落盘、不参与回放，故 app-streaming.js 在两个入口都前置短路；
    ② 状态只挂 sess._ctxLive，绝不写 sess.lastContextChunk —— 后者参与 createdAt 单调门禁
       与历史回放，写回去会用瞬态帧的 createdAt 顶掉权威快照；
    ③ 稳态帧绝不整卡重绘（.html(buildContextRows(...))）：hover 期间会闪烁并丢掉选区，
       只做定向改字。唯一例外是全新会话首帧需要一次性建立卡骨架（见 ensureContextMeterSkeleton）；
    ④ 所有收口路径统一走 endContextLive：结算 / 新轮 / done / 切会话 / reset，
       并绑定 runId，防止空闲窗口尾帧把已结算的实时值复活。 */

/** 同一动画帧内多次到达只落一次 DOM；无 rAF（后台标签页 / 测试沙箱）时同步回退。 */
var _ctxLiveRaf = 0;
var _ctxLivePendingSess = null;

/**
 * 统一的实时态收口：清 sess._ctxLive、取消挂起的 rAF、标死本 run。
 * <p>{@code _ctxLiveClosedRunId} 不能省：结算 / done 之后 WS 重连、gate buffer 排空、
 * 乱序或重复推送都可能再送来一个 tps_progress 尾帧，若只清对象不标 run，实时值会复活
 * 并覆盖刚结算的权威值，且不再有 context_size 来纠正。</p>
 * <p>{@code cancelAnimationFrame} 也不能省：rAF 挂起期间切会话/结算/新轮，回调仍会以旧
 * sess 为参数执行；只清 pending 不取消帧，切回旧会话时旧值会延时复活。</p>
 * @param {Object} sess - 所属会话（可空）
 * @param {Object} [chunk] - 触发收口的帧，用于取 runId（可空）
 */
function endContextLive(sess, chunk) {
    // rAF 句柄是模块级单例：无论有没有 sess 都必须归零，否则
    // resetContextIndicator(null) 之后 _ctxLiveRaf 永久非零，后续实时帧
    // 全部被 `if (_ctxLiveRaf) return` 吞掉，卡片再也不更新。
    // 只取消「挂起帧确实属于本次收口」的情况：其它会话的帧不该被顺手杀掉
    // （虽然单例 DOM 同一时刻只服务前台会话，仍不把正确性绑在帧序上）。
    if (_ctxLiveRaf && (!sess || _ctxLivePendingSess === sess || !_ctxLivePendingSess)) {
        try {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_ctxLiveRaf);
        } catch (e) { /* 无 rAF 环境静默 */ }
        _ctxLiveRaf = 0;
    }
    _ctxLivePendingSess = null;
    if (!sess) return;
    sess._ctxLive = undefined;
    // 骨架标记随结算作废：下一次 context_size 会走 renderContextMeter 正常显示卡片，
    // 而新 run 的首个实时帧需要重新建一次骨架。
    sess._ctxLiveSkeletonDone = undefined;
    var rid = chunk && chunk.runId;
    if (rid) sess._ctxLiveClosedRunId = rid;
}

/**
 * 全新会话首帧：进度环初始 {@code display:none}，且唯一让它显示的入口是
 * {@link renderContextMeter}（由 context_size 结算帧触发）。若实时帧不主动建骨架，
 * 单轮任务在整个流式输出期间卡片仍是隐藏的 —— 正是「执行完才显示」的原始报障。
 * <p>只在无权威快照时建立一次：用最小占位 chunk 走 renderContextMeter，让卡片显示、
 * 生成容量行与耗时行；随后 applyContextTpsLive 只做定向插行，不再整卡重绘。</p>
 */
function ensureContextMeterSkeleton(sess, chunk) {
    // 纯布尔标记，建过就不再建。不能用「pop-body 里有没有行」判断 —— 上一轮残留行
    // 或静态占位行会让它误判为已渲染，卡片永远不显示；也不能拿帧里可选的
    // runId / turnStartMs 做键 —— 后续实时帧通常不带这些字段，会算出不同的键
    // 导致每帧整卡重绘（hover 闪烁）。收口（结算/新轮/切会话/reset）时由
    // endContextLive 清除该标记，让下一个 run 能重新建卡。
    if (sess._ctxLiveSkeletonDone) return false;
    if (sess.lastContextChunk) return false;
    if (typeof $ !== 'function') return false;
    var $meter = $('.context-meter');
    if (!$meter.length) return false;
    var anchor = ctxRowNum(chunk.turnStartMs) || (sess._ctxTurnStartMs || 0);
    // 骨架只负责显示卡片 + 生成容量/耗时行；实时值由随后的 applyContextTpsLive
    // 局部插入，一次即可。若这里带上 liveMetrics（renderContextMeter 的回填逻辑），
    // 后面的插行会再补一次 TPS/TTFT 行，出现重复。
    var savedLive = sess._ctxLive;
    sess._ctxLive = undefined;
    try {
        renderContextMeter({
            args: { turnStartMs: anchor },
            createdAt: chunk.createdAt || Date.now(),
            totalTokens: 0, inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0, cacheRate: 0, text: ''
        }, sess);
    } finally {
        sess._ctxLive = savedLive;
    }
    sess._ctxLiveSkeletonDone = true;
    return true;
}

/**
 * 语言切换重译：{@code ctxTpsText} 把 {@code t('chat.tps_unit')} 拼进文本节点，
 * translateDOM 的静态 {@code [data-i18n]} 扫描覆盖不到。故把原始数值留在行节点属性上，
 * 在 {@code i18n:localeChanged}（由 GourdI18n.translateDOM 派发）时用新语言重算。
 * <p>不新增任何 i18n 键；即便钩子未挂上，数值仍在 {@code sess._ctxLive}，
 * 下一个 ≥500ms 的速率帧到达时会自愈。</p>
 */
function refreshContextTpsLiveI18n() {
    try {
        if (typeof $ !== 'function' || typeof GourdI18n === 'undefined' || !GourdI18n.t) return;
        var $meter = $('.context-meter');
        if (!$meter.length) return;
        var $tps = $meter.find('[data-ctx-tps]');
        if ($tps.length) {
            var n = Number($tps.attr('data-ctx-tps-n')) || 0;
            var ms = Number($tps.attr('data-ctx-tps-ms')) || 0;
            $tps.text(ctxTpsText({ generationMs: ms, generatedTokens: n }) || '--');
        }
        $meter.find('[data-ctx-tps-label]').text(GourdI18n.t('chat.output_tps'));
        $meter.find('[data-ctx-ttft-label]').text(GourdI18n.t('chat.ttft'));
    } catch (e) { /* 单个控件重译失败不得打断语言切换 */ }
}

/**
 * 把当前实时值定向写入悬停卡。
 * <p>行不存在时（{@code buildContextRows} 在缺数据时整行省略）只做局部插入：
 * 插到任务耗时行 {@code [data-ctx-elapsed]} 之前，维持「输出速度 → 首 Token 延迟 → 任务耗时」
 * 的既有顺序；连耗时行都没有时退化为 append 到 {@code .context-meter-pop-body} 末尾。</p>
 * <p>二次门禁不可省：rAF 是异步的，帧到达时是前台、回调执行时用户可能已切走会话，
 * 或期间结算帧已把 {@code _ctxLive} 清掉——这两种情况都不得再碰单例 DOM。</p>
 */
function applyContextTpsLive(sess) {
    try {
        if (!sess || sess._replaying) return;
        if (typeof activeSessionId !== 'undefined' && sess.sessionId !== activeSessionId) return;
        var metrics = sess._ctxLive;
        if (!metrics) return;   // 已被结算 / 新轮清掉：权威值优先，不复活实时行
        if (typeof $ !== 'function') return;
        var $meter = $('.context-meter');
        if (!$meter.length) return;   // DOM 未命中静默返回

        var tpsTxt = ctxTpsText(metrics) || '--';
        var ttftTxt = ctxTtftText(metrics) || '--';
        var $tps = $meter.find('[data-ctx-tps]');
        var $ttft = $meter.find('[data-ctx-ttft]');
        if (!$tps.length || !$ttft.length) {
            var $body = $meter.find('.context-meter-pop-body');
            if (!$body.length) return;
            var rows = (!$tps.length ? ctxTpsRow(tpsTxt, metrics) : '')
                + (!$ttft.length ? ctxTtftRow(ttftTxt) : '');
            var $elapsed = $body.find('[data-ctx-elapsed]');
            var $anchor = $elapsed.length ? $elapsed.closest('.context-meter-row') : null;
            if ($anchor && $anchor.length) $anchor.before(rows);
            else $body.append(rows);
            $tps = $meter.find('[data-ctx-tps]');
            $ttft = $meter.find('[data-ctx-ttft]');
        }
        if ($tps.length) {
            $tps.text(tpsTxt);
            // 原始数值留存在行节点上，供语言切换重算（translateDOM 扫不到内嵌译文）
            $tps.attr('data-ctx-tps-n', String(ctxRowNum(metrics.generatedTokens)));
            $tps.attr('data-ctx-tps-ms', String(ctxRowNum(metrics.generationMs)));
        }
        if ($ttft.length) $ttft.text(ttftTxt);
    } catch (e) { /* 异常静默：不得打断 onWebChunk 的帧管线 */ }
}

/**
 * tps_progress 帧的定向更新入口（由 app-streaming.js 的两个前置短路通过 window 调用）。
 * @param {Object} sess - 所属会话
 * @param {Object} chunk - tps_progress 帧；字段固定，刻意无 phase
 */
function updateContextTpsLive(sess, chunk) {
    try {
        // 前台门禁：回放帧与后台/历史帧一律不得写单例 DOM。
        // activeSessionId 可能 undefined（单会话/沙箱），此时放行。
        if (!sess || !chunk || sess._replaying) return;
        if (typeof activeSessionId !== 'undefined' && sess.sessionId !== activeSessionId) return;
        // 只认内核显式标记的运行中测量帧；结算帧不带 live，脏帧不得重建实时态。
        if (chunk.live !== true) return;
        // 已结算 run 的迟到尾帧（WS 重连 / gate buffer 排空 / 乱序 / 重复推送）一律丢弃：
        // 否则实时值会复活并覆盖刚结算的权威值，且不会再有 context_size 来纠正。
        if (chunk.runId && sess._ctxLiveClosedRunId === chunk.runId) return;
        // 新 run 开始：解除上一 run 的封印，允许本 run 的实时帧。
        if (chunk.runId && sess._ctxLiveClosedRunId && sess._ctxLiveClosedRunId !== chunk.runId) {
            sess._ctxLiveClosedRunId = undefined;
        }

        // 全新会话首帧：进度环初始 display:none，唯一显示入口是 context_size 结算帧。
        // 不主动建骨架的话，单轮任务整个流式期间卡片仍隐藏（原始报障）。仅一次整卡重绘。
        ensureContextMeterSkeleton(sess, chunk);

        var ttft = (typeof chunk.ttftMs === 'number' && isFinite(chunk.ttftMs) && chunk.ttftMs >= 0)
            ? Math.round(chunk.ttftMs) : undefined;
        // TTFT 是 run 级锁存值：后续帧万一缺字段，保留已锁存的值，避免行闪回 '--'
        var prev = sess._ctxLive;
        if (ttft === undefined && prev && typeof prev.ttftMs === 'number') ttft = prev.ttftMs;

        // 独立会话态：绝不写回 sess.lastContextChunk（污染 createdAt 单调门禁与历史回放）
        sess._ctxLive = {
            generationMs: ctxRowNum(chunk.generationMs),
            generatedTokens: ctxRowNum(chunk.generatedTokens),
            ttftMs: ttft
        };
        _ctxLivePendingSess = sess;

        if (typeof requestAnimationFrame === 'function') {
            if (_ctxLiveRaf) return;   // 合帧：同一动画帧内多次到达只落一次 DOM
            _ctxLiveRaf = requestAnimationFrame(function () {
                _ctxLiveRaf = 0;
                var s = _ctxLivePendingSess;
                _ctxLivePendingSess = null;
                // 二次门禁：挂起期间可能已结算 / 切会话 / 新轮，applyContextTpsLive
                // 会再校验一次 activeSessionId 与 _ctxLive，但这里先挡掉最廉价的情形。
                if (s && s._ctxLive) applyContextTpsLive(s);
            });
            return;
        }
        // 后台标签页 / 测试沙箱无 rAF：同步回退，保证首帧就能落字
        var s2 = _ctxLivePendingSess;
        _ctxLivePendingSess = null;
        if (s2 && s2._ctxLive) applyContextTpsLive(s2);
    } catch (e) { /* 异常静默：onWebChunk 已有节流日志，这里不得抛错 */ }
}

/* 暴露到 window 供其它模块调用（同 window.onFileChangesChunk）。
   守卫不可省：app-context.js 会被 node:vm 纯函数测试独立加载，沙箱里没有 window/document。 */
if (typeof window !== 'undefined' && window) {
    window.updateContextTpsLive = updateContextTpsLive;
    window.refreshContextTpsLiveI18n = refreshContextTpsLiveI18n;
    window.endContextLive = endContextLive;
    window.ensureContextMeterSkeleton = ensureContextMeterSkeleton;
}
/* i18n 的 translateDOM 每次切语言都会派发 'i18n:localeChanged'：挂上重算钩子。
    找不到钩子（沙箱/裁剪版页面）也没关系，数值留在 sess._ctxLive，下一帧自愈。
    幂等标记：HMR / 片段重载 / 测试重复执行同一文档时不得累积无法移除的匿名监听。 */
if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function'
        && !(typeof window !== 'undefined' && window && window.__contextTpsI18nBound)) {
    document.addEventListener('i18n:localeChanged', function () { refreshContextTpsLiveI18n(); });
    if (typeof window !== 'undefined' && window) window.__contextTpsI18nBound = true;
}

/**
 * 新一轮模型调用开始（reason_start 帧）：若 turnStartMs 已变（新一轮），作废旧一轮的
 * 定格耗时并让耗时行重新走表。
 *
 * <p><b>为何需要这个提前重置</b>：{@code context_size} 帧要等新一轮第一次模型调用结束
 * （{@code onReasonEnd}）才下发。在新一轮起步阶段（流式输出已开始、模型尚未结算）的窗口期，
 * 没有任何帧触发 {@link settledContextElapsed} 作废旧值，耗时行会一直停在上一轮 trace
 * 帧定格的旧值上不动——用户看到「任务耗时卡在上一轮的值」。切会话回放正常只是因为
 * 回放时新一轮的 {@code context_size} 已落盘。</p>
 *
 * <p>以 {@code turnStartMs} 为轮身份判据，与 {@link settledContextElapsed} 同口径，幂等：
 * 同一轮内多次 reason_start（工具调用后续跑）turnStartMs 不变，不重复清。</p>
 *
 * @param {Object} sess - 所属会话
 * @param {number} turnStartMs - reason_start 帧携带的本轮订阅时刻
 */
function noteContextTurnStart(sess, turnStartMs) {
    if (!sess || !(turnStartMs > 0)) return;
    // 新一轮开始：上一轮的滑窗速率/首字延迟立即作废，避免新轮起步阶段显示旧值。
    // 统一走 endContextLive：连带取消挂起的 rAF，防止切回旧会话时旧值延时复活。
    endContextLive(sess);
    // 无卡可绘时无需任何动作（新一轮 context_size 到达后自然建立）
    if (typeof activeSessionId !== 'undefined' && sess.sessionId !== activeSessionId) return;
    if (!sess.lastContextChunk) return;
    // 用「新轮起点」驱动一次重绘：renderContextMeter → settledContextElapsed 检测到
    // turnStartMs 跨轮后亲自作废旧定格值，耗时行随即按新起点重新走表，不再停在上一轮定格值。
    // 其余行（累计输入/输出等）沿用 lastContextChunk 的最新值，直到新一轮 context_size 帧
    // 到达后被权威值覆盖。绝不写回 sess.lastContextChunk——否则会用旧轮的 createdAt 顶掉它，
    // 破坏 updateContextIndicator 的单调时间戳门禁。
    var c = sess.lastContextChunk;
    var args = {};
    for (var k in (c.args || {})) { args[k] = c.args[k]; }
    args.turnStartMs = turnStartMs;
    // 新轮起步时，旧快照里的解码速率与首字延迟都属于上一轮：不随 lastContextChunk 复制，
    // 等新一轮首个 context_size 帧带权威值后再显示，避免「新一轮显示旧速率/旧延迟」。
    delete args.generationMs;
    delete args.generatedTokens;
    delete args.ttftMs;
    renderContextMeter({ args: args, text: c.text, totalTokens: c.totalTokens,
        inputTokens: c.inputTokens, outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens, cacheCreationTokens: c.cacheCreationTokens,
        cacheRate: c.cacheRate, createdAt: Date.now() }, sess);
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
    // 结算帧（context_size）携带权威累计值：清掉实时态，让 buildContextRows
    // 回退到 args.generationMs/generatedTokens/ttftMs。注意 createdAt 单调门禁
    // 早退发生在上面：那时尚无权威帧到达，实时值必须保留。
    // 必须在 renderContextMeter 之前清，否则整卡重绘的 liveMetrics 回填会把权威值顶回去。
    // 统一收口（含取消 rAF + 封印本 run），防止结算后迟到尾帧复活实时值。
    endContextLive(sess, chunk);
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

    // 无论有没有快照，切会话都必须结束实时态：
    // ① 单例 DOM 现在归目标会话，旧会话的挂起 rAF 不得再落字；
    // ② 后台会话的 context_size 只更新 lastContextChunk 不清 _ctxLive（见
    //    app-streaming.js 的 context_size 分支），若这里不清，切回时
    //    buildContextRows 的 liveMetrics 会覆盖权威结算值。
    // 实时态只在「仍在流式中且未结算」时有意义，而切会话那一刻它必然属于旧视野。
    endContextLive(sess);

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
    _ctxLivePendingSess = null;
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
