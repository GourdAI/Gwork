/* 渲染落点解耦回归测试（方案 C）。

   事故现象：任务一直显示执行中、后端接口持续被调用，但消息区定格不再更新，
   底部「任务 N / 本轮文件变更」等独立 DOM 仍在跳动。

   根因链（源码级实证）：
     1) 历史回放 replaySession 把 sess.container 整个替换成游离的临时 div，结束才换回；
     2) resetStreamState 里有一行 cancelAnimationFrame(sess._replayRafId)，会掐断回放分片链；
     3) 而 sendMessage / sendCommandSilent / sendWithFormDataGrouped 等路径无条件调用
        resetStreamState —— 打开一个正在跑的大会话（上万事件要跑几百帧、十几秒），
        期间发条消息或答个问答卡，回放即被掐断；
     4) replayDone 永不执行 → sess.container 永久指向孤儿节点，且 _replaying/_gateBuffering
        门禁永不释放 → 后续实时帧全被扣在 _gateBuffer，界面僵死。

   修复：sess.container 语义恒定（永远是文档里的真实容器），新增 sess.renderTarget 表达
   「这一刻新节点落在哪」，渲染类代码一律经 renderRoot(sess) 取落点；resetStreamState 不再
   掐断回放；回放全链路（同步段 / 分片 rAF / replayDone）异常兜底统一收尾。

   本文件同时用「真实行为沙箱」和「契约护栏」两种方式锁定，防止日后被悄悄改回去。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const baseJs = readStatic('js', 'app-base.js');
const historyJs = readStatic('js', 'app-history.js');
const messageJs = readStatic('js', 'app-message.js');
const streamingJs = readStatic('js', 'app-streaming.js');

/* 按花括号配平抽取函数体（与仓库既有测试同一范式） */
function fnBody(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '未找到函数: ' + name);
    let depth = 0, seen = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') { depth--; if (seen && depth === 0) return source.slice(start, i + 1); }
    }
    assert.fail('函数体未配平: ' + name);
}

/* ===== 一、真实行为：renderRoot / isDetachedRenderTarget / abortReplay ===== */

function loadRenderApi(extra) {
    const src = fnBody(baseJs, 'renderRoot')
        + '\n' + fnBody(baseJs, 'isDetachedRenderTarget')
        + '\n' + fnBody(baseJs, 'abortReplay')
        + '\nreturn { renderRoot: renderRoot, isDetachedRenderTarget: isDetachedRenderTarget, abortReplay: abortReplay };';
    const env = Object.assign({
        cancelAnimationFrame() {},
        releaseScrollAnchor: undefined,
        drainGateBuffer: undefined
    }, extra || {});
    return new Function('__env', 'with(__env){ ' + src + ' }')(env);
}

test('renderRoot：默认返回真实容器，回放期返回临时落点', () => {
    const api = loadRenderApi();
    const real = { id: 'real' };
    const temp = { id: 'temp' };
    const sess = { container: real, renderTarget: null };

    assert.equal(api.renderRoot(sess), real, '平时必须落在真实容器');
    assert.equal(api.isDetachedRenderTarget(sess), false);

    sess.renderTarget = temp;
    assert.equal(api.renderRoot(sess), temp, '回放期必须落在临时容器');
    assert.equal(api.isDetachedRenderTarget(sess), true, '游离落点必须可判定，供滚动等副作用跳过');

    // 落点等于真实容器时不算游离（防止误判把正常滚动也跳过）
    sess.renderTarget = real;
    assert.equal(api.isDetachedRenderTarget(sess), false);
});

test('abortReplay：中止回放必须同时还原落点、释放门禁、排空缓冲', () => {
    const calls = { cancel: 0, release: 0, drain: 0 };
    const api = loadRenderApi({
        cancelAnimationFrame() { calls.cancel++; },
        releaseScrollAnchor() { calls.release++; },
        drainGateBuffer() { calls.drain++; }
    });

    const sess = {
        container: { id: 'real' },
        renderTarget: { id: 'temp' },
        _replaying: true,
        _replayRafId: 42,
        _replayClock: 123,
        _skipScroll: true,
        _replayLoadingMore: true
    };

    assert.equal(api.abortReplay(sess), true);
    assert.equal(sess.renderTarget, null, '落点必须还原，否则后续渲染写进孤儿节点');
    assert.equal(sess._replaying, false, '回放门禁必须释放');
    assert.equal(sess._replayRafId, null);
    assert.equal(sess._skipScroll, false);
    assert.equal(sess._replayLoadingMore, false);
    assert.equal(calls.cancel, 1);
    assert.equal(calls.release, 1, '必须释放滚动锚点，否则视口被永久锁住');
    assert.equal(calls.drain, 1, '必须排空 _gateBuffer，否则实时帧永远送不到界面');

    // 非回放态调用是安全的 no-op
    calls.drain = 0;
    assert.equal(api.abortReplay(sess), false);
    assert.equal(calls.drain, 0, '非回放态不得误排空缓冲');
    assert.equal(api.abortReplay(null), false);
});

test('abortReplay：门禁已释放但 rAF 句柄残留时，仍须清掉挂起帧', () => {
    /* 防御的是「只释放门禁、漏清句柄」的半收尾态：正常路径两者同步成对，但那是约定
       而非结构保证。残留的挂起帧会在调用方清空容器后继续往已摘除的节点渲染。
       语义边界：此时仍是非回放态，故返回值必须是 false，且不得排空 _gateBuffer。 */
    const calls = { cancel: 0, release: 0, drain: 0 };
    const api = loadRenderApi({
        cancelAnimationFrame() { calls.cancel++; },
        releaseScrollAnchor() { calls.release++; },
        drainGateBuffer() { calls.drain++; }
    });

    const sess = { container: { id: 'real' }, renderTarget: null, _replaying: false, _replayRafId: 77 };

    assert.equal(api.abortReplay(sess), false, '非回放态的返回值语义不得改变');
    assert.equal(calls.cancel, 1, '残留的回放 rAF 必须被取消，否则继续渲染已摘除的节点');
    assert.equal(sess._replayRafId, null, '句柄必须清空，避免后续重复取消');
    assert.equal(calls.drain, 0, '非回放态仍不得误排空缓冲');
    assert.equal(calls.release, 0, '非回放态不涉及滚动锚点');
});

/* ===== 二、根因护栏：resetStreamState 不得再掐断回放 ===== */

test('resetStreamState 不得取消回放分片链（本次事故的直接成因）', () => {
    const reset = fnBody(baseJs, 'resetStreamState');
    /* 只看可执行代码：注释里正引用这段历史（说明为什么不能掐），不应被算作违规。
       注意区分 abortReplay —— 它是销毁路径，取消 rAF 正是它的职责，不在本护栏范围内。*/
    const resetCode = reset.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(resetCode, /cancelAnimationFrame\(sess\._replayRafId\)/,
        'resetStreamState 掐断回放 = replayDone 永不执行 = 门禁永不释放 = 界面僵死');
    assert.doesNotMatch(resetCode, /sess\._replayRafId\s*=\s*null/,
        '同理不得在此清空回放 rAF 句柄');
    // 反向确认：abortReplay 里必须保留取消（否则销毁会话后分片链还在跑）
    assert.match(fnBody(baseJs, 'abortReplay'), /cancelAnimationFrame\(sess\._replayRafId\)/,
        'abortReplay 作为销毁路径必须取消回放 rAF');
    // 其它两个 rAF（正文/思考增量渲染）仍必须取消，属于本会话渲染状态
    assert.match(reset, /cancelAnimationFrame\(sess\.contentRafId\)/);
    assert.match(reset, /cancelAnimationFrame\(sess\.reasonRafId\)/);
});

test('销毁类路径必须显式 abortReplay（LRU 淘汰 / 删除会话 / 清空全部）', () => {
    const evict = fnBody(baseJs, 'evictInactiveSessions');
    assert.match(evict, /abortReplay\(sess\)/, 'LRU 淘汰要清空 DOM，必须先中止回放');
    // 删除会话与清空全部在 app-history.js，且必须在移除容器之前
    assert.match(historyJs, /abortReplay\(sess\);\s*\n\s*\$\(sess\.container\)\.remove\(\);/,
        '删除会话必须先中止回放，否则分片 rAF 继续渲染已删除的会话');
    assert.match(historyJs, /abortReplay\(cs\);\s*\n\s*\$\(cs\.container\)\.remove\(\);/,
        '清空全部会话同理');
});

/* ===== 三、容器语义恒定：回放不得再替换 sess.container ===== */

test('回放只切换渲染落点，绝不替换 sess.container', () => {
    // 全仓渲染链中不得再出现对 sess.container 的赋值
    for (const [name, src] of [['app-base.js', baseJs], ['app-history.js', historyJs],
                               ['app-message.js', messageJs], ['app-streaming.js', streamingJs]]) {
        const hits = (src.match(/^\s*sess\.container\s*=[^=]/gm) || []);
        assert.equal(hits.length, 0, name + ' 不得再替换 sess.container（容器语义必须恒定）');
    }
    const replay = fnBody(historyJs, 'replaySession');
    assert.match(replay, /sess\.renderTarget = tempDiv;/, '回放必须改用渲染落点');
    assert.match(replay, /sess\.renderTarget = null;/, '回放结束必须还原落点');
});

test('渲染落点覆盖全部建节点入口（append / find 新建节点）', () => {
    // 这些函数会在回放期被调用，必须落在临时容器，否则回放内容直接写进真实容器造成错乱
    const mustUseRoot = [
        'appendUserMessage', 'appendSystemNotice', 'ensureAssistantBubble',
        'showThinking', 'takeoverArgsStreamingCard', 'removeOrphanArgsStreamingCards',
        'handleRewind'
    ];
    for (const name of mustUseRoot) {
        const body = fnBody(messageJs, name);
        assert.match(body, /renderRoot\(sess\)/, name + ' 必须经 renderRoot 取渲染落点');
        /* 建节点必须落在渲染落点：append/find 新建节点一律不得用 sess.container。
           例外：ensureAssistantBubble 内的 rerun 回调按 data-run-id 删除旧回复行，
           那是用户点击时作用于文档中已有行的操作，真实容器才是正确目标。*/
        const buildCode = name === 'ensureAssistantBubble'
            ? body.slice(0, body.indexOf('function triggerCommand'))
            : body;
        assert.doesNotMatch(buildCode, /\$\(sess\.container\)/, name + ' 建节点不得直接使用 sess.container');
    }
    // 单独确认 rerun 删行仍作用于真实容器（不能被误改成临时落点，否则点重跑删不掉旧回复）
    assert.match(fnBody(messageJs, 'ensureAssistantBubble'),
        /\$\(sess\.container\)\.find\('\[data-run-id="' \+ runId \+ '"\]'\)\.remove\(\);/,
        'rerun 删除同 runId 旧回复必须作用于真实容器');
});

test('finishStream 与回放 endTurn 的扫尾都按渲染落点', () => {
    const finish = fnBody(streamingJs, 'finishStream');
    assert.match(finish, /var finishRoot = renderRoot\(sess\);/);
    assert.doesNotMatch(finish, /\$\(sess\.container\)/, 'finishStream 不得直接扫 sess.container');
    assert.match(finish, /purgeEmptyMdBlocks\(renderRoot\(sess\)\)/);

    const replay = fnBody(historyJs, 'replaySession');
    assert.match(replay, /var turnRoot = renderRoot\(sess\);/, '回放 endTurn 扫尾必须用落点');
    assert.match(replay, /purgeEmptyMdBlocks\(renderRoot\(sess\)\)/,
        '空块清扫必须限定在本页新建节点，否则 prepend 会误删文档已有行');
});

/* ===== 四、滚动门控回归点（容器恒定后 document.contains 恒为真） ===== */

test('appendUserMessage：回放期必须靠落点判定跳过滚动', () => {
    const body = fnBody(messageJs, 'appendUserMessage');
    assert.match(body, /!isDetachedRenderTarget\(sess\)/,
        '容器语义恒定后 document.contains 恒为真，必须显式判定落点是否游离，否则回放期每条消息都会抢滚视口');
    assert.match(body, /document\.contains\(sess\.container\)/, '真实容器的存在性检查仍需保留');
});

/* ===== 五、异常兜底：任何失败都不得留下僵死态 ===== */

test('回放三层异常兜底齐备（同步段 / 分片 rAF / replayDone）', () => {
    const replay = fnBody(historyJs, 'replaySession');
    assert.match(replay, /function finishReplayFallback\(err\)/, '必须有统一兜底出口');

    // 兜底必须做全四件事，少一件就会僵死
    const fallback = replay.slice(replay.indexOf('function finishReplayFallback'));
    assert.match(fallback, /sess\.renderTarget = null;/, '兜底必须还原落点');
    assert.match(fallback, /sess\._replaying = false;/, '兜底必须释放回放门禁');
    assert.match(fallback, /drainGateBuffer\(sess\)/, '兜底必须排空实时帧缓冲');
    assert.match(fallback, /releaseScrollAnchor/, '兜底必须释放滚动锚点');

    // 三个入口都要接兜底
    assert.match(replay, /replayDoneCore\(\);\s*\n\s*\}\s*catch \(err\) \{\s*\n\s*finishReplayFallback\(err\);/,
        'replayDone 必须包异常兜底');
    assert.match(replay, /requestAnimationFrame\(function\(\) \{[\s\S]*?try \{[\s\S]*?replayChunk\(\);[\s\S]*?catch \(err\) \{[\s\S]*?finishReplayFallback\(err\)/,
        '分片 rAF 回调必须包兜底：回调抛异常无人接管会直接断链');
    assert.match(replay, /try \{\s*\n\s*replayChunk\(\);\s*\n\s*\} catch \(err\) \{\s*\n\s*finishReplayFallback\(err\);/,
        '首帧同步执行同样要兜底');
});

test('兜底不得丢内容：半成品要并入真实容器', () => {
    const replay = fnBody(historyJs, 'replaySession');
    const fallback = replay.slice(replay.indexOf('function finishReplayFallback'));
    assert.match(fallback, /while \(tempDiv\.firstChild\) salvage\.appendChild\(tempDiv\.firstChild\);/,
        '临时容器里已渲染的内容必须抢救回真实容器，不能凭空消失');
    assert.match(fallback, /if \(prepend\) realContainer\.insertBefore\(salvage, realContainer\.firstChild\);/,
        'prepend 与初始加载的插入方向不同，必须分别处理');
});

test('loadMessagesLegacy：修复 realContainer 作用域陷阱', () => {
    const legacy = fnBody(historyJs, 'loadMessagesLegacy');
    // 旧实现把 realContainer 声明在 try 内，异常发生在赋值前时兜底整个失效
    assert.match(legacy, /var realContainer = null;\s*\n\s*var tempDiv = null;\s*\n\s*try \{/,
        '局部变量必须声明在 try 外，否则异常兜底会踩 undefined');
    assert.doesNotMatch(legacy, /if \(realContainer\) sess\.container = realContainer;/,
        '旧的依赖局部变量的兜底写法必须移除');
    assert.match(legacy, /sess\.renderTarget = tempDiv;/);
    assert.match(legacy, /sess\.renderTarget = null;/);
});

test('loadMessages 回放异常分支清的是真实容器', () => {
    const load = fnBody(historyJs, 'loadMessages');
    assert.match(load, /abortReplay\(sess\)/, '回放异常必须先中止回放释放门禁');
    assert.match(load, /\$\(sess\.container\)\.html\(''\)/,
        '清的必须是真实容器（旧实现此刻 container 已被换成临时容器，清了个孤儿节点）');
});
