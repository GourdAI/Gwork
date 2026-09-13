const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../..');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (...parts) => fs.readFileSync(path.join(moduleRoot, 'src/main/java', ...parts), 'utf8').replace(/^\uFEFF/, '');

/* 取顶层函数体：项目里的函数都以列 0 的 '}' 收尾，与既有测试的切片手法一致 */
function fnBody(src, name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
    const m = src.match(re);
    assert.ok(m, name + ' 应存在于源码中');
    return m[0];
}

/* ===== 回归背景 =====
   模型流式生成大参数（write 一整篇 md）时，参数本身可持续 80+ 秒。
   旧行为：这段时间屏幕完全无反馈（底部还错误地显示「输出中」），随后工具卡「突然冒出来」且已是完成态。
   新行为：后端在模型刚确定函数名时下发 action_draft（建骨架卡），参数生成期持续下发 action_args
   （累计字节数），参数齐备后 action_start 到达，骨架卡原地转为正式卡。
   三种帧共享同一个原生 ToolCall.id，因此全程只有一张 DOM 卡片。
   下列契约锁死该链路，防止回退成「两张卡 / 永久 loading / 黄点空卡」。 */

test('onWebChunk 分发新增 action_draft / action_args 两个 case，并与 action_start 对齐归属路由', () => {
    const js = readStatic('js', 'app-streaming.js');
    assert.match(js, /case 'action_draft': finishThinkingBlock\(sess\); clearRetryChunk\(sess\);/);
    // 骨架卡同样要能落进子代理卡片内部，否则会先画在主对话、转正时再跳回卡内
    assert.match(js, /case 'action_draft'[\s\S]*?var draftOwnerState = resolveAgentState\(sess, chunk\.args\);[\s\S]*?if \(draftOwnerState\) \{ finishAgentThinkingBlock\(sess, draftOwnerState\); \}/);
    assert.match(js, /appendActionDraftChunk\(sess, chunk\.toolName, chunk\.toolTitle, chunk\.actionId, chunk\.args\);/);
    assert.match(js, /case 'action_args':[\s\S]*?updateToolCardArgsProgress\(sess, chunk\.actionId, chunk\.argsBytes\);/);
    // 两个 case 必须落在 onWebChunk 的 type 分发 switch 内
    const dispatch = js.match(/switch \(chunk\.type\) \{[\s\S]*?\n        \}/);
    assert.ok(dispatch, 'onWebChunk 的 switch 应存在');
    assert.match(dispatch[0], /case 'action_draft':/);
    assert.match(dispatch[0], /case 'action_args':/);
});

test('inferPhaseFromType 把两种新帧映射到 PHASE_TOOL，且底部指示器继续对 PHASE_TOOL 让位', () => {
    const js = readStatic('js', 'app-streaming.js');
    const infer = fnBody(js, 'inferPhaseFromType');
    assert.match(infer, /case 'action_draft': case 'action_args': return PHASE_TOOL;/);
    // 骨架卡已承担进度语义，底部「输出中/思考中」必须继续短路，不得为了新帧解除
    const indicator = fnBody(js, 'showPhaseIndicator');
    assert.match(indicator, /if \(phase === PHASE_TOOL \|\| phase === PHASE_HITL \|\| phase === PHASE_RETRY \|\| phase === PHASE_DONE\) return;/);
});

test('工具卡 DOM 只有一套模板：骨架卡与正式卡共用 createToolCardShell', () => {
    const js = readStatic('js', 'app-message.js');
    assert.match(js, /function createToolCardShell\(sess, toolName, args, toolTitle, actionId, agentBody, argsStr\) \{/);
    const shell = fnBody(js, 'createToolCardShell');
    assert.match(shell, /<span class="tool-status-icon loading"><\/span>/);
    assert.match(shell, /<div class="tool-card-body"><\/div>/);
    assert.match(shell, /applyToolPresentation\(card, toolName, toolTitle, toolPresentationOptions\(agentBody, args\)\);/);
    // 两条建卡路径都不得再自己拼 innerHTML，否则两套结构会漂移
    const start = fnBody(js, 'appendActionStartChunk');
    const draft = fnBody(js, 'appendActionDraftChunk');
    assert.match(start, /createToolCardShell\(sess, toolName, args, presentationTitle, actionId, insertAgentBody, argsStr\);/);
    assert.doesNotMatch(start, /card\.innerHTML = '<div class="tool-card-header">/, 'action_start 不得保留自建 DOM 的旧分支');
    assert.match(draft, /createToolCardShell\(sess, bareToolName, args, presentationTitle, actionId, insertAgentBody, ''\);/);
    assert.doesNotMatch(draft, /innerHTML/, '骨架卡不得自建 DOM');
});

test('骨架卡状态点必须保持 loading 原样（否则 setToolCardStatus 的 loading 守卫会让它永久落不了态）', () => {
    const js = readStatic('js', 'app-message.js');
    const draft = fnBody(js, 'appendActionDraftChunk');
    assert.doesNotMatch(draft, /tool-status-icon/, '骨架卡不得改写状态点 class');
    assert.match(draft, /\$\(card\)\.addClass\('args-streaming'\);/, '视觉区分只走根节点 class');
    assert.match(draft, /card\.setAttribute\('data-args-streaming', '1'\);/);
    // 守卫本身必须还在：它是「骨架卡不能动状态点」这条约束的根因
    const setStatus = fnBody(js, 'setToolCardStatus');
    assert.match(setStatus, /if \(icon\.className\.indexOf\('loading'\) < 0\) return;/);
});

test('appendActionDraftChunk：幂等、登记 actionId、子代理路由与滚动收尾', () => {
    const js = readStatic('js', 'app-message.js');
    assert.match(js, /function appendActionDraftChunk\(sess, toolName, toolTitle, actionId, args\) \{/);
    const draft = fnBody(js, 'appendActionDraftChunk');
    assert.match(draft, /if \(!actionId\) return;/, '无 actionId 无法幂等配对，不建骨架');
    assert.match(draft, /if \(sess\.completedActionIds && sess\.completedActionIds\[actionId\]\) return;/);
    assert.match(draft, /if \(sess\.toolCardsById && sess\.toolCardsById\[actionId\]\) return;/);
    assert.match(draft, /sess\.toolCardsById\[actionId\] = card;/);
    // 子代理路由与 action_start 同机制
    assert.match(draft, /var insertAgentBody = resolveAgentCardBody\(sess, args\);/);
    assert.match(draft, /\$\(insertAgentBody\)\.append\(card\);[\s\S]*?followAgentCardBody\(insertAgentBody, findAgentStateByBody\(sess, insertAgentBody\)\);/);
    assert.match(draft, /insertBeforeActions\(sess, card\);/);
    assert.match(js, /window\.appendActionDraftChunk = appendActionDraftChunk;/);
});

test('updateToolCardArgsProgress：未命中容错、rAF 合帧、字节格式化三档', () => {
    const js = readStatic('js', 'app-message.js');
    assert.match(js, /function updateToolCardArgsProgress\(sess, actionId, argsBytes, cardEl\) \{/);
    const upd = fnBody(js, 'updateToolCardArgsProgress');
    // 未命中（帧早于建卡 / 卡已转正或已移除）必须静默返回，不得抛错打断 onWebChunk
    assert.match(upd, /if \(!card \|\| !card\.getAttribute \|\| !card\.getAttribute\('data-args-streaming'\)\) return;/);
    assert.match(upd, /GourdI18n\.t\('chat\.args_streaming', \{ size: formatArgsBytes\(bytes\) \}\)/);
    assert.match(upd, /card\._argsProgressRaf = requestAnimationFrame\(/);
    assert.match(upd, /if \(card\._argsProgressRaf\) return;/, '同一帧内的重复进度只写一次');
    const fmt = fnBody(js, 'formatArgsBytes');
    assert.match(fmt, /return n \+ ' B';/);
    assert.match(fmt, /' KB'/);
    assert.match(fmt, /' MB'/);
});

test('重复 action_start 不再直接 return：骨架卡原地回填，非骨架卡才忽略', () => {
    const js = readStatic('js', 'app-message.js');
    assert.doesNotMatch(js, /重复 action_start：忽略，不建第二张卡/, '旧的静默 return 分支必须移除');
    const start = fnBody(js, 'appendActionStartChunk');
    assert.match(start, /if \(actionId && sess\.toolCardsById && sess\.toolCardsById\[actionId\]\) \{[\s\S]*?adoptArgsStreamingCard\(sess, sess\.toolCardsById\[actionId\], toolName, args, presentationTitle,\s*insertAgentBody, batchMeta, argsStr\);[\s\S]*?return;/);
    const adopt = fnBody(js, 'adoptArgsStreamingCard');
    // 非骨架卡返回 false：真重复帧仍旧不建第二张
    assert.match(adopt, /if \(!card \|\| !card\.getAttribute \|\| !card\.getAttribute\('data-args-streaming'\)\) return false;/);
    assert.match(adopt, /clearArgsStreamingMark\(card\);/);
    assert.match(adopt, /applyToolPresentation\(card, toolName, presentationTitle, toolPresentationOptions\(agentBody, args, card\)\);/);
    assert.match(adopt, /updateToolHeaderMeta\(card, toolName, args, null\);/);
    assert.match(adopt, /formatToolArgsStr\(args\)/);
    // batchMeta 只在正式帧下发，转正时才可能需要把卡搬进批量容器
    assert.match(adopt, /if \(!card\.getAttribute\('data-batch-key'\)\) appendCardToBatch\(sess, card, batchMeta, agentBody\);/);
    // 状态点保持 loading：落态仍归 action_end
    assert.doesNotMatch(adopt, /tool-status-icon/);
    const clear = fnBody(js, 'clearArgsStreamingMark');
    assert.match(clear, /card\.removeAttribute\('data-args-streaming'\);/);
    assert.match(clear, /\$\(card\)\.removeClass\('args-streaming'\);/);
    assert.match(clear, /\$\(card\)\.find\('\.tool-args-progress'\)\.remove\(\);/);
    assert.match(clear, /cancelAnimationFrame\(card\._argsProgressRaf\)/);
});

test('孤儿骨架卡是被移除而不是标黄点（finishStream 与回放 endTurn 两条收尾路径都要）', () => {
    const msg = readStatic('js', 'app-message.js');
    const purge = fnBody(msg, 'removeOrphanArgsStreamingCards');
    assert.match(purge, /\$\(sess\.container\)\.find\('\.tool-card\[data-args-streaming\]'\)\.each/);
    assert.match(purge, /\$\(card\)\.remove\(\);/, '必须是移除 DOM');
    assert.doesNotMatch(purge, /tool-status-icon warn/, '不得退化成标黄点');
    assert.match(purge, /delete sess\.toolCardsById\[actionId\];/, '移除同时要摘登记，避免悬挂引用');
    assert.match(msg, /window\.removeOrphanArgsStreamingCards = removeOrphanArgsStreamingCards;/);

    // finishStream：清理必须发生在 loading→warn 扫尾之前，否则骨架卡会先被染黄
    const streaming = readStatic('js', 'app-streaming.js');
    const finish = fnBody(streaming, 'finishStream');
    assert.match(finish, /removeOrphanArgsStreamingCards\(sess\);[\s\S]*?\$\(sess\.container\)\.find\('\.tool-card:not\(\[data-batch-key\]\)\ \.tool-status-icon\.loading'\)/);

    // 回放 endTurn：同构处理，两条收尾路径语义必须一致
    const history = readStatic('js', 'app-history.js');
    assert.match(history, /removeOrphanArgsStreamingCards\(sess\);\s*\n\s*\$\(sess\.container\)\.find\('\.tool-status-icon\.loading'\)/);
});

test('markToolCardFailed 跳过骨架卡：尚未执行的调用不得被标红', () => {
    const js = readStatic('js', 'app-message.js');
    const failed = fnBody(js, 'markToolCardFailed');
    assert.match(failed, /\.tool-card:not\(\[data-args-streaming\]\) \.tool-status-icon\.loading/);
    // 批量分组头部的 loading 仍要置红（原行为不得丢）
    assert.match(failed, /\.tool-batch-header \.tool-status-icon\.loading/);
    assert.match(failed, /removeOrphanArgsStreamingCards\(sess\);/);
    assert.doesNotMatch(failed, /find\('\.tool-status-icon\.loading'\)/, '旧的「全量置红」选择器必须收窄');
});

test('HITL 审批卡接管骨架卡，避免同一工具出现两张卡（其一永久 loading）', () => {
    const js = readStatic('js', 'app-message.js');
    const takeover = fnBody(js, 'takeoverArgsStreamingCard');
    assert.match(takeover, /function takeoverArgsStreamingCard\(sess, toolName, actionId\)/,
        '必须接收 actionId 形参');
    // 优先按 actionId 精确命中：并发同名工具不得串卡
    assert.match(takeover, /if \(actionId && sess\.toolCardsById\) \{\s*var byId = sess\.toolCardsById\[actionId\];/,
        'actionId 有值时必须先按 id 精确命中，不得直接进入 toolName 遍历');
    assert.match(takeover, /byId\.getAttribute\('data-args-streaming'\) !== null/,
        '按 id 命中的卡必须仍是骨架卡，已收到 action_start 转正的卡不能被抢走');
    // 降级路径必须保留：actionId 字段新增前落盘的挂起任务，恢复后取不到 id
    assert.match(takeover, /if \(!found && toolName\) \{[\s\S]*?if \(this\.getAttribute\('data-tool-name'\) === toolName\) found = this;/,
        'actionId 缺失时必须能降级按工具名匹配，歧义时取最后一张');
    assert.match(takeover, /delete sess\.toolCardsById\[foundId\];/);
    assert.match(takeover, /clearArgsStreamingMark\(found\);/);

    const hitl = fnBody(js, 'appendHitlCard');
    assert.match(hitl, /function appendHitlCard\(sess, toolName, command, actionId\)/);
    assert.match(hitl, /var card = takeoverArgsStreamingCard\(sess, toolName, actionId\);/);
    assert.match(hitl, /if \(card\) \{\s*\$\(card\)\.addClass\('hitl-pending expanded'\);\s*\} else \{/, '命中则原地改造，未命中才新建');
    assert.match(hitl, /hitl-card-actions/);
    assert.match(hitl, /tool-status-icon warn/, '审批态仍是 warn 状态点');
    assert.match(hitl, /if \(!card\.parentNode\) insertBeforeActions\(sess, card\);/, '已在流中的卡不得被重新插到底部');
    // 审批按钮仍完整存在（接管改造不得吃掉按钮绑定）
    assert.match(hitl, /var approveBtn = \$\(card\)\.find\('\.hitl-btn-approve'\)\[0\];/);
    assert.match(hitl, /var rejectBtn = \$\(card\)\.find\('\.hitl-btn-reject'\)\[0\];/);
    // 审批卡不得按旧 actionId 登记：批准后会重走 Reason，action_start 携带的是新 id，
    // 同一张卡改由 sess.approvedToolCard 分支接管，按旧 id 登记只会留下永不被消费的悬挂引用
    assert.doesNotMatch(hitl, /sess\.toolCardsById\[actionId\] = /,
        '审批卡不得登记旧 actionId');
});

test('hitl 帧全链路携带 actionId：ActionTask → ToolExchanger → HITLTask → WebChunk → 前端', () => {
    // 1) 与 ToolCallStartEvent 用同一个 actionId 变量，保证与骨架卡同源
    const action = readJava('com/gourdai/agent/react/task/ActionTask.java');
    assert.match(action, /new ToolExchanger\(toolName, args, actionId\);/);

    // 2) 交换器承载并暴露
    const exchanger = readJava('com/gourdai/agent/react/task/ToolExchanger.java');
    assert.match(exchanger, /private final String actionId;/);
    assert.match(exchanger, /public String getActionId\(\) \{\s*return actionId;\s*\}/);
    assert.match(exchanger, /public ToolExchanger\(String toolName, Map<String, Object> args\) \{\s*this\(toolName, args, null\);\s*\}/,
        '旧两参构造必须保留并委托，不得破坏既有调用方');

    // 3) 挂起时写入 HITLTask
    const interceptor = readJava('com/gourdai/agent/react/intercept/HITLInterceptor.java');
    assert.match(interceptor, /new HITLTask\(toolExchanger\.getToolName\(\),[\s\S]*?comment, toolExchanger\.getActionId\(\)\)/);

    // 4) HITLTask 持有（会话快照走 JSON，旧数据缺字段即 null，故前端必须保留降级）
    const task = readJava('com/gourdai/agent/react/intercept/HITLTask.java');
    assert.match(task, /private String actionId;/);
    assert.match(task, /public String getActionId\(\)/);
    assert.match(task, /public HITLTask\(String toolName, Map<String, Object> args, String comment\) \{\s*this\(toolName, args, comment, null\);\s*\}/,
        '旧三参构造必须保留，反序列化与既有调用方不受影响');

    // 5) 投影到 hitl 帧
    const chunk = readJava('com/gourdai/core/portal/web/WebChunk.java');
    assert.match(chunk, /public static WebChunk ofHitl\(String toolName, String command, String actionId\) \{[\s\S]*?tmp\.actionId = actionId;/);
    const builder = readJava('com/gourdai/core/portal/web/WebStreamBuilder.java');
    assert.match(builder, /WebChunk\.ofHitl\(task\.getToolName\(\), command, task\.getActionId\(\)\)/);

    // 6) 前端消费
    const streaming = readStatic('js', 'app-streaming.js');
    assert.match(streaming, /appendHitlCard\(sess, chunk\.toolName, chunk\.command, chunk\.actionId\)/);

    // 7) 桌面通道零改动生效的前提：ONode 出口本就透传 actionId（删掉它桌面端就会退回按工具名匹配）
    const ws = readJava('com/gourdai/core/portal/desktop/WsGate.java');
    assert.match(ws, /if \(chunk\.getActionId\(\) != null\) node\.set\("actionId", chunk\.getActionId\(\)\);/,
        '桌面端 hitl 帧靠这一行带上 actionId');
});

test('骨架帧不落盘，历史回放零变化：回放管线不识别也不需要这两种 type', () => {
    const store = readJava('com/gourdai/core/portal/web/SessionStreamStore.java');
    assert.match(store, /"action_draft"\.equals\(type\) \|\| "action_args"\.equals\(type\)/, '后端必须跳过瞬态帧落盘');
    const history = readStatic('js', 'app-history.js');
    assert.doesNotMatch(history, /'action_draft'|'action_args'/, '回放层不得为瞬态帧新增特判分支');
    // 回放仍由 action_start + action_end 重建卡片
    assert.match(history, /removeOrphanArgsStreamingCards\(sess\);/, '回放收尾只需兜底清理，不改重建逻辑');
});

test('12 个语言包均含 chat.args_streaming，且保留 {size} 占位符', () => {
    const dir = path.join(staticRoot, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 12, '语言包数量应不少于 12');
    for (const f of files) {
        const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        assert.equal(typeof json.chat.args_streaming, 'string', f + ' 缺少 chat.args_streaming');
        assert.ok(json.chat.args_streaming.includes('{size}'), f + ' 的 args_streaming 丢失 {size} 占位符');
    }
});

test('进度文案参与语言切换重译（否则切语言后整条漏译）', () => {
    const js = readStatic('js', 'app-message.js');
    const reloc = fnBody(js, 'relocalizeDynamicLabels');
    assert.match(reloc, /document\.querySelectorAll\('\.tool-args-progress\[data-args-bytes\]'\)/);
    assert.match(reloc, /GourdI18n\.t\('chat\.args_streaming', \{ size: formatArgsBytes\(el\.getAttribute\('data-args-bytes'\)\) \}\)/);
    // 写文案处必须同时写下字节数，重译才有据可依
    const upd = fnBody(js, 'updateToolCardArgsProgress');
    assert.match(upd, /el\.setAttribute\('data-args-bytes', String\(bytes\)\);/);
});

test('CSS：骨架卡与进度文案复用既有设计令牌，四态状态点语义不变', () => {
    const css = readStatic('css', 'app.css');
    assert.match(css, /\.tool-card\.args-streaming \{ border-style: dashed; \}/);
    assert.match(css, /\.tool-args-progress \{ order: 3; color: var\(--text-tertiary\); font-size: 12px; font-variant-numeric: tabular-nums;/);
    // 不得引入硬编码颜色
    const progressRule = css.match(/\.tool-args-progress \{[^}]*\}/);
    assert.ok(progressRule);
    assert.doesNotMatch(progressRule[0], /#[0-9a-fA-F]{3,8}|rgba?\(/, '进度文案样式不得硬编码颜色');
    const skeletonRule = css.match(/\.tool-card\.args-streaming \{[^}]*\}/);
    assert.doesNotMatch(skeletonRule[0], /#[0-9a-fA-F]{3,8}|rgba?\(/, '骨架卡样式不得硬编码颜色');
    // 现有四态不得被改动
    assert.match(css, /\.tool-status-icon\.loading \{ background: var\(--color-success, #4ac26b\); border: none; animation: status-dot-blink 1s ease-in-out infinite; \}/);
    assert.match(css, /\.tool-status-icon\.done \{ background: var\(--color-success, #4ac26b\); border: none; animation: none; box-shadow: 0 0 4px rgba\(74,194,107,0\.6\); \}/);
    assert.match(css, /\.tool-status-icon\.warn \{ background: var\(--color-warning\); border: none; animation: none; \}/);
    assert.match(css, /\.tool-status-icon\.reject \{ background: var\(--color-danger, #e5534b\); border: none; animation: none; box-shadow: 0 0 4px rgba\(229,83,75,0\.6\); \}/);
});
