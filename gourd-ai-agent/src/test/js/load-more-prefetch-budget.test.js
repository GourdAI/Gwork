/**
 * 回归：顶部自动加载的「预取配额」行为。
 *
 * <p>事故背景（用户实测）：「拉到顶部加载消息后再往下拉，一直加载、拉不到底部」。
 * 根因是 prepend 后的锚点修正执行 scrollTop += 新增高度，而浏览器对 scrollTop 赋值会
 * <b>同步再派发一次 scroll</b>；新增高度不足阈值(240px)时立刻触发下一页，形成自激闭环。
 * 抽真实源码实测：每页 40px 时单次滚动连发 7 次、60px 时 5 次、120px 时 3 次。</p>
 *
 * <p>但「一次滚动只兑一页」同样不可取：后端单页受 96KB 响应预算硬约束
 * （smart-socket 按 128 字节递归写出，>130KB 必栈溢出），7.6MB 会话除下来就是 ~80 页。
 * 故取中道：每次真实滚动发放固定配额，自激链最多连拉这么多页即止。</p>
 *
 * <p>本用例不做源码字符串匹配（那种护栏抓不住行为），而是把 app-history.js 里真实的
 * scroll handler 抽出来注入受控替身执行，断言其实际连发次数。</p>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const historyJs = fs.readFileSync(
    path.resolve(__dirname, '../../main/resources/static/js/app-history.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

/** 括号配平地抽出 scroll handler 函数体（正则截断会把内层 } 当结尾）。 */
function extractScrollHandler() {
    const marker = "$(messagesWrap).on('scroll', function() {";
    const start = historyJs.indexOf(marker);
    assert.ok(start >= 0, '未找到顶部自动加载的 scroll handler');
    let i = start + marker.length;
    let depth = 1;
    while (i < historyJs.length && depth > 0) {
        const c = historyJs[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    assert.ok(depth === 0, 'scroll handler 括号未配平');
    return historyJs.slice(start + marker.length, i);
}

/**
 * 构造 handler 工厂。配额变量声明必须留在<b>函数外层闭包</b>：
 * 若混进函数体，var 会被提升为局部变量、每次调用重置，配额永远耗不尽（测试会假绿）。
 */
function makeHandlerFactory() {
    const decl = historyJs.match(
        /var LOAD_MORE_PREFETCH_PAGES = (\d+);\s*\nvar _loadMoreScrollBudget = LOAD_MORE_PREFETCH_PAGES;/);
    assert.ok(decl, '未找到预取配额的声明对（LOAD_MORE_PREFETCH_PAGES / _loadMoreScrollBudget）');
    const body = extractScrollHandler();
    const factory = new Function(decl[0] + `
        return function (messagesWrap, activeSessionId, sessionMap, setLoadMoreBtnLoading, loadMoreMessages) {
            ${body}
        };`);
    return { factory, quota: Number(decl[1]) };
}

/**
 * 模拟一次用户滚动，返回自激链实际触发的加载次数。
 * @param pageHeight prepend 一页后锚点修正带来的 scrollTop 增量（像素）
 */
function simulateOneScroll(factory, pageHeight, startTop) {
    const handler = factory();          // 每轮重建闭包 = 干净的模块状态
    const wrap = { scrollTop: startTop };
    const sess = {
        _replayHasMore: true, _replayLoadingMore: false,
        _replaying: false, _gateBuffering: false
    };
    const sessionMap = { s1: sess };
    let loads = 0;
    const loadMore = () => {
        loads++;
        wrap.scrollTop += pageHeight;   // app-history.js replayDone 的锚点修正
        // 浏览器对 scrollTop 赋值会同步派发 scroll —— 自激闭环就在这里
        if (loads < 500) handler(wrap, 's1', sessionMap, () => {}, loadMore);
    };
    handler(wrap, 's1', sessionMap, () => {}, loadMore);
    return loads;
}

test('顶部自动加载：自激链被预取配额封顶，不会无限连发', () => {
    const { factory, quota } = makeHandlerFactory();
    // 每页高度越小自激越猛（修复前：40px→7 次、60px→5 次、120px→3 次）。
    // 40px 是最恶劣情形，必须恰好被配额截停。
    for (const h of [10, 40, 60, 120, 240]) {
        const loads = simulateOneScroll(factory, h, 0);
        assert.ok(loads <= quota,
            `每页高度 ${h}px 时单次滚动触发了 ${loads} 次加载，超过预取配额 ${quota}`);
        assert.ok(loads >= 1, `每页高度 ${h}px 时一页都没加载，自动加载失效`);
    }
});

test('顶部自动加载：新增高度越过阈值即自然收敛，无需依赖配额', () => {
    const { factory } = makeHandlerFactory();
    // 阈值是 240，单页高度 241 起一次修正就能移出触发区 —— 此时应恰好 1 次。
    // 这条守住「配额不是遮羞布」：正常内容量下本就不该连发。
    assert.equal(simulateOneScroll(factory, 241, 0), 1, '单页高度超过阈值时不应连发');
    assert.equal(simulateOneScroll(factory, 400, 0), 1);
});

test('顶部自动加载：配额在用户移出阈值区后恢复，不会永久哑火', () => {
    const { factory, quota } = makeHandlerFactory();
    const handler = factory();
    const wrap = { scrollTop: 0 };
    const sess = {
        _replayHasMore: true, _replayLoadingMore: false,
        _replaying: false, _gateBuffering: false
    };
    const sessionMap = { s1: sess };
    let loads = 0;
    const loadMore = () => {
        loads++;
        wrap.scrollTop += 40;
        if (loads < 500) handler(wrap, 's1', sessionMap, () => {}, loadMore);
    };

    handler(wrap, 's1', sessionMap, () => {}, loadMore);
    const first = loads;
    assert.ok(first > 0 && first <= quota, `首轮应在配额内加载，实际 ${first}`);

    // 用户主动向下滚出阈值区 —— 这是配额的唯一补充时机
    wrap.scrollTop = 800;
    handler(wrap, 's1', sessionMap, () => {}, loadMore);
    // 再次拉回顶部
    wrap.scrollTop = 0;
    handler(wrap, 's1', sessionMap, () => {}, loadMore);

    const second = loads - first;
    assert.ok(second > 0,
        '配额未恢复：用户拉到顶部一次后自动加载永久失效（比自激更严重的回归）');
    assert.ok(second <= quota, `第二轮同样须受配额约束，实际 ${second}`);
});

test('顶部自动加载：回放/缓冲/加载中状态下不得触发', () => {
    const { factory } = makeHandlerFactory();
    for (const blocking of ['_replayLoadingMore', '_replaying', '_gateBuffering']) {
        const handler = factory();
        const wrap = { scrollTop: 0 };
        const sess = {
            _replayHasMore: true, _replayLoadingMore: false,
            _replaying: false, _gateBuffering: false
        };
        sess[blocking] = true;
        let loads = 0;
        handler(wrap, 's1', { s1: sess }, () => {}, () => { loads++; });
        assert.equal(loads, 0, `${blocking} 为真时不应触发加载（会与 prepend 滚动补偿打架）`);
    }
});

test('顶部自动加载：没有更多内容时不触发', () => {
    const { factory } = makeHandlerFactory();
    const handler = factory();
    let loads = 0;
    handler({ scrollTop: 0 }, 's1',
        { s1: { _replayHasMore: false } }, () => {}, () => { loads++; });
    assert.equal(loads, 0, 'hasMore 为假时必须收手');
});
