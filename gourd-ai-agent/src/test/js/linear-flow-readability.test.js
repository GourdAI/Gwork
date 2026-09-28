/**
 * 契约测试：线性流的「零点击可读性」——折叠态摘要行 + 参数摘要信息密度。
 *
 * 为什么需要它（问题溯源）：
 * 主对话默认 cliPrintSimplified=true（折叠态），而折叠时卡体【根本不构建 DOM】
 * （见 tool-body-lazy-build.test.js 覆盖的懒构建）。改造前折叠态下：
 *   - .tool-args 是 display:none，bash 的 command / grep 的 pattern / websearch 的 query
 *     只存在于参数里 → 这些调用在界面上【没有任何可辨识信息】；
 *   - 卡体不构建 → 输出也看不到；
 * 于是「一轮 50 次工具调用 = 50 次点击」，正是用户抱怨的「每次加载消息都要点击」。
 *
 * 对标源码（已在 vendor 克隆核实，非臆测）：
 *   - Codex  codex-rs/tui/src/agent_status_feed.rs:17  AGENT_STATUS_PREVIEW_LINES = 3，
 *     preview_lines() 用 lines.drain(..lines.len()-3) 保留【末尾】行；
 *   - ZCode  packages/ui/src/components/ai-elements/reasoning.tsx
 *     resolveReasoningStreamingSummary() 反向遍历取【末条非空行】，返回 {key,text}，
 *     且仅在 isStreaming && !isOpen 时计算（展开后不出摘要）。
 * 故本地口径：工具输出取【首行】（结果概览）、连续思考取【末行】（最新进展），展开后隐藏。
 *
 * 覆盖：
 * - 真实源码区块在沙箱中执行的行为（非源码字符串比对）
 * - 增量跟踪器与全量取行的【等价性】（含随机分块 fuzz，专抓 trim/跨帧行边界/重置错位）
 * - 增量路径的分配优势有实测数据支撑，但正确性优先：等价性不成立则优化无意义
 * - DOM 落点：预览必须落在【header 内】（与图标同一条行，用户拍板的单行展示），
 *   不得是卡体里的独立 div（独立行会随流式增删让卡片高度忽高忽低）；空文本必须移除节点
 * - 参数摘要的语义优先级 / 单键免前缀 / 数组展开 / 抑制重复键
 * - CSS 契约：预览行内样式（.preview-inline：单行截断/弹性收缩/order）、
 *   展开态隐藏预览、.tool-args 不再 display:none
 *
 * 变异验证（.tmp/mutcheck_preview.js）：把 endLineResult 的 .trim() 改成只去尾空白、
 * 或去掉 resetThinkingPreview 接线、或把 .tool-args 改回 display:none，本测试必须失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const message = readStatic('js', 'app-message.js');
const appCss = readStatic('css', 'app.css');

/* ===== 提取真实源码区块 =====
   【坑·CRLF】本文件是 CRLF，end marker 里带 '\n' 的多行字符串永远匹不上；
   且只切到某条语句会把函数闭合大括号留在外面，得到语法不完整的代码
   （表现为一堆 SyntaxError，很像真实缺陷其实是脚手架 bug）。
   故一律「定位起始注释 → 定位下一个区块的起始注释 → 取其前」的方式切整块。 */
function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, '未找到区块起始标记: ' + startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, '未找到区块结束标记: ' + endMarker);
    return source.slice(start, end);
}
const previewBlock = sliceBetween(message,
    '/* ===== 折叠态单行摘要（零点击可读）=====',
    '/* 卡体跟随底部：');
const argsBlock = sliceBetween(message,
    '/* 头部参数摘要的可见字符上限。',
    '/* 工具卡公共展示更新：');

/* 区块自身必须语法完整（防后人改动后又切出半截代码） */
test('区块提取完整：能被解析为合法 JS', () => {
    assert.doesNotThrow(() => new Function('document', 'GourdI18n', previewBlock), '预览区块语法不完整');
    assert.doesNotThrow(() => new Function('GourdI18n', argsBlock), '参数摘要区块语法不完整');
});

/* ===== 微型 DOM 桩：只实现被测区块用到的 API =====
   不用 jsdom（仓库既有测试均无此依赖），手写桩还能把「选择器口径」变成显式契约：
   被测代码若改用后代选择器，桩会直接抛错而不是静默返回错误节点。 */
function makeEl(tagName, className) {
    const el = {
        tagName, className: className || '', children: [], parentNode: null,
        textContent: '', title: '',
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c, ref) {
            c.parentNode = el;
            const i = ref ? el.children.indexOf(ref) : -1;
            if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
            return c;
        },
        removeChild(c) {
            const i = el.children.indexOf(c);
            if (i >= 0) { el.children.splice(i, 1); c.parentNode = null; }
            return c;
        },
        get firstElementChild() { return el.children.length ? el.children[0] : null; },
        /* 必须实现 nextSibling：被测代码用 insertBefore(el, anchor.nextSibling) 锚定插入位置。
           桩里缺这个属性时 nextSibling 是 undefined，insertBefore 会退化成「追加到末尾」，
           于是产品代码正确而测试报错——排查时极易误判成产品缺陷（已实际踩过）。 */
        get nextSibling() {
            if (!el.parentNode) return null;
            const sibs = el.parentNode.children;
            const i = sibs.indexOf(el);
            return i >= 0 && i + 1 < sibs.length ? sibs[i + 1] : null;
        },
        querySelector(sel) {
            const m = /^:scope > \.([\w-]+)$/.exec(sel);
            /* 契约：预览行必须是【直接子元素】。agent 卡体内会嵌子工具卡，
               用后代选择器会抓到子卡的预览行并覆写它。桩在此强制该口径。 */
            if (!m) throw new Error('测试 DOM 桩只支持 ":scope > .cls"，被测代码用了: ' + sel);
            return el.children.find(c => String(c.className || '').split(/\s+/).includes(m[1])) || null;
        }
    };
    return el;
}

function createSandbox() {
    const doc = { createElement: (t) => makeEl(t) };
    const i18n = { t: (k) => (k === 'chat.items' ? ' 项' : k) };
    const factory = new Function('document', 'GourdI18n',
        previewBlock + '\n' + argsBlock + '\n'
        + 'return { pickPreviewLine: pickPreviewLine, setPreviewLine: setPreviewLine,'
        + ' applyPreviewLine: applyPreviewLine, createEndLineTracker: createEndLineTracker,'
        + ' trackEndLine: trackEndLine, resetEndLineTracker: resetEndLineTracker,'
        + ' endLineResult: endLineResult, clipPreview: clipPreview,'
        + ' setPreviewLineIncremental: setPreviewLineIncremental,'
        + ' thinkingPreviewTracker: thinkingPreviewTracker, resetThinkingPreview: resetThinkingPreview,'
        + ' formatToolArgsStr: formatToolArgsStr, PREVIEW_MAX_CHARS: PREVIEW_MAX_CHARS,'
        + ' ARG_MAX_CHARS: ARG_MAX_CHARS };');
    return factory(doc, i18n);
}
const api = createSandbox();

/* 造一个「header + 卡体占位」的工具卡宿主。预览已并入 header：
   造卡时 header 里预置图标/工具名/状态点，验证预览 append 后不干扰它们。 */
function makeCardHost() {
    const card = makeEl('div', 'tool-card');
    const header = makeEl('div', 'tool-card-header');
    header.appendChild(makeEl('span', 'tool-type-icon'));
    header.appendChild(makeEl('span', 'tool-name'));
    header.appendChild(makeEl('span', 'tool-status-icon loading'));
    card.appendChild(header);
    card.appendChild(makeEl('div', 'tool-card-body'));
    return card;
}
/* 造一个思考块宿主 */
function makeThinkingHost() {
    const blk = makeEl('div', 'thinking-block');
    const header = makeEl('div', 'thinking-block-header');
    header.appendChild(makeEl('span', 'tool-type-icon'));
    header.appendChild(makeEl('span', 'thinking-block-label'));
    header.appendChild(makeEl('span', 'thinking-status-dot'));
    blk.appendChild(header);
    blk.appendChild(makeEl('div', 'thinking-block-body'));
    return blk;
}
const previewOf = (host, cls) => {
    const header = host.children[0];
    return header.children.find(c => String(c.className).split(/\s+/).includes(cls)) || null;
};

/* =====================================================================
   1. 取行口径：工具输出取首行，思考取末行
   ===================================================================== */
test('工具输出预览取【首行】：结果概览在最前，与 Codex 头部预览一致', () => {
    const p = api.pickPreviewLine('第一行结果概览\n第二行\n第三行', false);
    assert.equal(p.text, '第一行结果概览');
    assert.equal(p.more, 2, '首行之后还有 2 行，应给出 +N 计数');
});

test('思考预览取【末条非空行】：与 ZCode resolveReasoningStreamingSummary 同口径', () => {
    const p = api.pickPreviewLine('早期想法\n中期想法\n最新进展\n\n   \n', true);
    assert.equal(p.text, '最新进展', '必须跳过尾部空行/纯空白行');
    assert.equal(p.more, 2, '命中行之前有 2 行');
});

test('跳过首部空行：工具输出前的空行不得成为摘要', () => {
    const p = api.pickPreviewLine('\n\n   \n真正的首行\n次行', false);
    assert.equal(p.text, '真正的首行');
    assert.equal(p.more, 1);
});

test('全空/空白文本返回 null（调用方据此移除预览节点）', () => {
    assert.equal(api.pickPreviewLine('', false), null);
    assert.equal(api.pickPreviewLine(null, true), null);
    assert.equal(api.pickPreviewLine('\n   \n\t\n', true), null);
    assert.equal(api.pickPreviewLine('\n   \n\t\n', false), null);
});

test('超长行裁切到上限并加省略号（防止一行摘要吃掉整屏）', () => {
    const long = 'x'.repeat(api.PREVIEW_MAX_CHARS + 500);
    const p = api.pickPreviewLine(long + '\n尾行', false);
    assert.equal(p.text.length, api.PREVIEW_MAX_CHARS, '裁切后长度必须恰为上限');
    assert.ok(p.text.endsWith('…'), '必须以省略号结尾');
});

test('单行文本 more=0：不显示无意义的「+0」', () => {
    assert.equal(api.pickPreviewLine('只有一行', false).more, 0);
    assert.equal(api.pickPreviewLine('只有一行', true).more, 0);
});

/* =====================================================================
   2. 增量跟踪器 ≡ 全量取行（正确性是优化的前提）
   ===================================================================== */
test('增量逐帧推进：结果与全量取末行完全等价（含 more 计数）', () => {
    const full = '第一段推理\n  缩进的第二段  \n\n第三段\n最后一段结论';
    const st = api.createEndLineTracker();
    let acc = '';
    /* 逐字符喂入 = 最极端的分块方式，任何跨帧行边界处理错误都会暴露 */
    for (const ch of full) {
        acc += ch;
        const inc = api.trackEndLine(st, acc);
        const ref = api.pickPreviewLine(acc, true);
        assert.deepEqual(
            inc ? { text: inc.text, full: inc.full, more: inc.more } : null,
            ref ? { text: ref.text, full: ref.full, more: ref.more } : null,
            '在第 ' + acc.length + ' 字符处不等价，当前累积=' + JSON.stringify(acc)
        );
    }
});

test('增量等价性 fuzz：随机文本 × 随机分块 × 随机重置（500 轮）', () => {
    /* 字符池刻意包含：换行、行首缩进空白、行尾空白、CRLF、普通中文、ASCII。
       CRLF 与缩进是最容易让「增量」与「全量」产生分歧的两类输入。 */
    const pool = ['推', '理', 'a', '1', ' ', '\t', '\n', '\r\n', '  ', '内容'];
    let seed = 20260926;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    for (let round = 0; round < 500; round++) {
        const totalLen = 1 + rnd(40);
        let text = '';
        for (let i = 0; i < totalLen; i++) text += pool[rnd(pool.length)];

        const st = api.createEndLineTracker();
        /* 随机切分成若干帧（1..len），模拟真实 token 到达的不均匀性 */
        let pos = 0;
        while (pos < text.length) {
            const step = 1 + rnd(Math.min(6, text.length - pos));
            pos = Math.min(text.length, pos + step);
            const acc = text.slice(0, pos);
            const inc = api.trackEndLine(st, acc);
            const ref = api.pickPreviewLine(acc, true);
            assert.deepEqual(
                inc ? { text: inc.text, full: inc.full, more: inc.more } : null,
                ref ? { text: ref.text, full: ref.full, more: ref.more } : null,
                'fuzz 第' + round + '轮 pos=' + pos + ' 不等价，text=' + JSON.stringify(acc)
            );
        }
    }
});

test('行首缩进必须被 trim：增量与全量不得出现「一条带缩进一条不带」', () => {
    /* 这是我实现增量版时真实写出过的缺陷：快路径只 replace(/\s+$/,'')（去尾）没去首，
       而全量版是 .trim()（双端）。思考文本常有 markdown 缩进列表，两条路径就会分叉。 */
    const st = api.createEndLineTracker();
    api.trackEndLine(st, '首行\n');
    const inc = api.trackEndLine(st, '首行\n   带缩进的当前行');
    const ref = api.pickPreviewLine('首行\n   带缩进的当前行', true);
    assert.equal(inc.text, ref.text, '缩进处理必须一致');
    assert.equal(inc.text, '带缩进的当前行', '行首空白必须去掉');
});

test('跟踪器重置后从零开始：不得沿用上一段的 scanned/lastIdx', () => {
    const st = api.createEndLineTracker();
    api.trackEndLine(st, '上一段思考\n上一段末行');
    api.resetEndLineTracker(st);
    /* 重置后喂入更短的文本：若 scanned 没归零，text.length < scanned 会走兜底重扫（也算对），
       但 lastIdx/lastText 若没清，兜底之外的路径就会返回上一段的残留摘要 */
    const p = api.trackEndLine(st, '新一段');
    assert.deepEqual({ text: p.text, more: p.more }, { text: '新一段', more: 0 });
    assert.equal(api.endLineResult(st).text, '新一段');
});

test('holder 级跟踪器：懒创建 + 重置配对（resetThinkingPreview）', () => {
    const h = {};
    const st1 = api.thinkingPreviewTracker(h);
    assert.ok(st1, '首次访问应懒创建');
    assert.equal(api.thinkingPreviewTracker(h), st1, '同一 holder 必须复用同一跟踪器');

    api.trackEndLine(st1, '思考内容\n末行');
    assert.equal(st1.scanned > 0, true, '前置条件：跟踪器已推进');
    api.resetThinkingPreview(h);
    assert.equal(st1.scanned, 0, 'buffer 归零时跟踪器必须一并归零');
    assert.equal(st1.lastIdx, -1);
    assert.equal(st1.partial, '');
});

test('resetThinkingPreview 对未初始化 holder 安全（不得抛错）', () => {
    assert.doesNotThrow(() => api.resetThinkingPreview({}),
        '新建思考块时跟踪器可能尚未创建，重置必须容忍 undefined');
});

test('兜底自愈：外部把 buffer 换短（漏重置）时自行全量重扫而非永久错位', () => {
    const st = api.createEndLineTracker();
    api.trackEndLine(st, '很长很长的一段思考内容\n它的末行在这里');
    assert.ok(st.scanned > 10);
    /* 模拟「buffer 被重置但跟踪器漏重置」：文本变短 */
    const p = api.trackEndLine(st, '短');
    assert.deepEqual({ text: p.text, more: p.more }, { text: '短', more: 0 },
        '必须自愈到正确摘要，不得返回上一段的残留');
    assert.equal(st.scanned, 1, 'scanned 应重新对齐到当前文本长度');
});

test('增量路径的分配优势：8000 帧下不得退化为逐帧全文 split（护栏）', () => {
    /* 这是本次优化的目的本身，用「源码里流式路径不得调用全量 setPreviewLine」来锁。
       行为层面：增量版每帧只处理 delta，若有人把 afterRender 改回全量调用，
       下面的调用点断言会失败（配合 mutcheck 的 M3 变异）。 */
    const st = api.createEndLineTracker();
    let acc = '';
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 8000; i++) {
        acc += (i % 9 === 8 ? '\n' : '') + '推理内容' + i;
        api.trackEndLine(st, acc);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    /* 实测增量版 ~3ms；全量 split 版 ~495ms。阈值取 60ms：
       足够宽松以免 CI 抖动误报，又能明确区分两种实现（8× 余量）。 */
    assert.ok(ms < 60, '增量推进 8000 帧应远快于全量 split，实测 ' + ms.toFixed(1) + 'ms');
    assert.equal(api.pickPreviewLine(acc, true).text, api.endLineResult(st).text, '末帧结果仍须与全量一致');
});

/* =====================================================================
   3. DOM 落盘：并入 header / 移除 / 展开隐藏
   ===================================================================== */
test('工具输出预览落在 header 内（与图标同一条行），不得是卡体里的独立 div', () => {
    const card = makeCardHost();
    api.setPreviewLine(card, 'tool-card-preview', 'BUILD SUCCESS\nTests run: 630', false);
    const header = card.children.find(c => String(c.className).includes('tool-card-header'));
    const cardKids = card.children.map(c => c.className);
    assert.ok(!cardKids.some(n => String(n).includes('tool-card-preview')),
        '预览不得再落在卡体层（独立 div 会让折叠态高度随流式增删而忽高忽低）');
    const el = previewOf(card, 'tool-card-preview');
    assert.ok(el, '预览应在 header 内');
    assert.ok(String(el.className).includes('preview-inline'),
        '预览须携带 .preview-inline（并入标题行的样式与 CSS 契约钩子）');
    assert.ok(String(el.className).includes('tool-card-preview'), '语义类须保留');
    const headerKids = header.children.map(c => String(c.className));
    assert.ok(headerKids.includes('tool-status-icon loading'), '原有元素不得被清掉');
    assert.equal(headerKids[headerKids.length - 1], 'tool-card-preview preview-inline',
        '预览 append 到 header 末尾（视觉顺序由 CSS order 决定，不由 DOM 位置）');
});

test('思考预览同样落在 header 内（末行语义不变，与工具预览同规则）', () => {
    const blk = makeThinkingHost();
    api.setPreviewLine(blk, 'thinking-block-preview', '旧想法\n最新想法', true);
    const blkKids = blk.children.map(c => c.className);
    assert.ok(!blkKids.some(n => String(n).includes('thinking-block-preview')),
        '思考预览不得再落在块体层（旧实现追加到块末尾，高度忽高忽低）');
    const el = previewOf(blk, 'thinking-block-preview');
    assert.ok(el, '思考预览应在 header 内');
    assert.equal(el.textContent, '最新想法 · +1', '末行 + 前置行计数（与工具预览同口径）');
});

test('宿主无 header（或 header 不是首子元素）时静默不渲染；有 header 则正常落盘', () => {
    const orphan = makeEl('div', 'tool-card');
    orphan.appendChild(makeEl('div', 'tool-card-body'));
    assert.doesNotThrow(() => api.setPreviewLine(orphan, 'tool-card-preview', '输出', false));
    assert.equal(orphan.children.length, 1, '无 header 不得追加任何节点');

    const firstIsHeader = makeEl('div', 'tool-card');
    firstIsHeader.appendChild(makeEl('div', 'tool-card-header'));
    firstIsHeader.appendChild(makeEl('div', 'tool-card-body'));
    assert.doesNotThrow(() => api.setPreviewLine(firstIsHeader, 'tool-card-preview', '输出', false));
    assert.ok(previewOf(firstIsHeader, 'tool-card-preview'), 'header 在首位时应正常落盘');
});

test('增量版与全量版落盘位置一致（共用 applyPreviewLine，不得漂移）', () => {
    const a = makeThinkingHost(), b = makeThinkingHost();
    api.setPreviewLine(a, 'thinking-block-preview', 'x\ny\nz', true);
    const st = api.createEndLineTracker();
    api.trackEndLine(st, 'x\n'); api.trackEndLine(st, 'x\ny\n'); api.setPreviewLineIncremental(b, 'thinking-block-preview', 'x\ny\nz', st);
    assert.deepEqual(
        a.children[0].children.map(c => c.className),
        b.children[0].children.map(c => c.className));
    assert.equal(previewOf(a, 'thinking-block-preview').textContent, previewOf(b, 'thinking-block-preview').textContent);
});

test('同宿主重复写入只更新文本，不得堆叠多个预览节点', () => {
    const card = makeCardHost();
    api.setPreviewLine(card, 'tool-card-preview', '第一次输出', false);
    api.setPreviewLine(card, 'tool-card-preview', '第二次输出', false);
    api.setPreviewLine(card, 'tool-card-preview', '第三次输出', false);
    const header = card.children.find(c => String(c.className).includes('tool-card-header'));
    const all = header.children.filter(c => String(c.className).includes('tool-card-preview'));
    assert.equal(all.length, 1, '必须原地更新，重复节点会让标题行越来越拥挤');
    assert.equal(all[0].textContent, '第三次输出');
});

test('空结果必须移除预览节点：不得留占位', () => {
    const card = makeCardHost();
    api.setPreviewLine(card, 'tool-card-preview', '有输出', false);
    assert.ok(previewOf(card, 'tool-card-preview'));
    api.setPreviewLine(card, 'tool-card-preview', '', false);
    assert.equal(previewOf(card, 'tool-card-preview'), null, '空文本要摘掉节点');
    const header = card.children.find(c => String(c.className).includes('tool-card-header'));
    assert.deepEqual(header.children.map(c => c.className),
        ['tool-type-icon', 'tool-name', 'tool-status-icon loading'], 'header 内其余元素不得被误删');
});

test('增量喂入全空文本同样摘掉节点（思考只有空白时不留空行）', () => {
    const blk = makeThinkingHost();
    const st = api.createEndLineTracker();
    api.setPreviewLineIncremental(blk, 'thinking-block-preview', '   \n\t\n', st);
    assert.equal(previewOf(blk, 'thinking-block-preview'), null);
});

test('more>0 时文本带「· +N」计数，more=0 时不带（Codex 的 lines-hidden 口径）', () => {
    const card = makeCardHost();
    api.setPreviewLine(card, 'tool-card-preview', '首行\n次行\n三行', false);
    assert.equal(previewOf(card, 'tool-card-preview').textContent, '首行 · +2');

    const card2 = makeCardHost();
    api.setPreviewLine(card2, 'tool-card-preview', '只有一行', false);
    assert.equal(previewOf(card2, 'tool-card-preview').textContent, '只有一行', '单行不得出现「+0」');
});

test('title 挂【未裁切的全文】：截断后仍可悬停读到完整行', () => {
    const card = makeCardHost();
    const long = 'y'.repeat(api.PREVIEW_MAX_CHARS + 100) + '\n第二行';
    api.setPreviewLine(card, 'tool-card-preview', long, false);
    const el = previewOf(card, 'tool-card-preview');
    assert.equal(el.textContent.length, api.PREVIEW_MAX_CHARS + ' · +1'.length,
        '可见文本应为裁切后的长度 + more 后缀');
    assert.ok(el.textContent.endsWith('… · +1'), '可见文本以省略号与计数收尾');
    assert.equal(el.title, 'y'.repeat(api.PREVIEW_MAX_CHARS + 100),
        'title 必须是未裁切的整行全文，否则悬停读不到被省略的尾部');
    assert.ok(el.title.length > el.textContent.length, 'title 应比可见文本更长');
});

test('title 全文在增量路径同样成立（两条路径不得一条有全文一条没有）', () => {
    const blk = makeThinkingHost();
    const st = api.createEndLineTracker();
    const longLine = 'k'.repeat(api.PREVIEW_MAX_CHARS + 60);
    api.setPreviewLineIncremental(blk, 'thinking-block-preview', '首行\n' + longLine, st);
    const el = previewOf(blk, 'thinking-block-preview');
    assert.equal(el.title, longLine, '增量路径的 title 也必须是整行全文');
});

test('跨帧喂入的长行：title 仍是整行全文（partial 累积不得丢前缀）', () => {
    const blk = makeThinkingHost();
    const st = api.createEndLineTracker();
    const longLine = 'm'.repeat(api.PREVIEW_MAX_CHARS + 40);
    let acc = '';
    /* 逐 10 字符喂入，模拟 token 粒度到达 */
    for (let i = 0; i < longLine.length; i += 10) {
        acc = longLine.slice(0, i + 10);
        api.setPreviewLineIncremental(blk, 'thinking-block-preview', acc, st);
    }
    const el = previewOf(blk, 'thinking-block-preview');
    assert.equal(el.title, longLine, '分帧累积后 title 必须等于完整行');
    assert.equal(el.textContent.length, api.PREVIEW_MAX_CHARS);
});

test('宿主为 null 时静默返回（流式早期 thinkingBlockEl 可能尚未建）', () => {
    assert.doesNotThrow(() => api.setPreviewLine(null, 'tool-card-preview', 'x', false));
    assert.doesNotThrow(() => api.setPreviewLineIncremental(null, 'thinking-block-preview', 'x', api.createEndLineTracker()));
});

test('只认 header 直接子元素：agent 卡内嵌的子工具卡预览不得被外层覆写', () => {
    /* agent 卡的 header 没有 tool-card-preview 落点（它不是预览宿主），
     * 预览只会在各自 header 内：外层调用不会碰子卡 header 里的预览。
     * 本用例锁「外层写入不覆盖子卡 header 内的预览」这一隔离性。 */
    const outer = makeEl('div', 'agent-card');
    outer.appendChild(makeEl('div', 'agent-card-header'));
    const inner = makeCardHost();
    api.setPreviewLine(inner, 'tool-card-preview', '子工具卡的输出', false);
    outer.appendChild(inner);
    /* 外层写入自己的预览：agent-card-header 不是映射表里的 header，不落盘，也不会碰子卡 */
    api.setPreviewLine(outer, 'tool-card-preview', '外层的输出', false);
    assert.equal(previewOf(inner, 'tool-card-preview').textContent, '子工具卡的输出', '子卡预览必须保持不变');
    assert.equal(previewOf(outer, 'tool-card-preview'), null,
        'agent 卡不是预览宿主（无 tool-card-preview 映射的 header），不应落盘');
});

/* =====================================================================
   4. 接线：三处 buffer 重置都必须配对重置跟踪器
   ===================================================================== */
test('thinkingBuffer 归零处必须紧跟 resetThinkingPreview（漏一处=摘要永久错位）', () => {
    /* 用「归零语句的下一行必须是重置调用」来锁，而不是数出现次数：
       只数次数的话，三处重置挤在同一个函数里也能凑够数。 */
    const lines = message.split(/\r?\n/);
    const hits = [];
    lines.forEach((ln, i) => { if (/h\.thinkingBuffer\s*=\s*'';/.test(ln)) hits.push(i); });
    assert.ok(hits.length >= 3, '预期至少 3 处 buffer 归零（新建/复用/收敛），实际 ' + hits.length);
    for (const i of hits) {
        const next = (lines[i + 1] || '') + (lines[i + 2] || '');
        assert.ok(/resetThinkingPreview\(h\)/.test(next),
            '第 ' + (i + 1) + ' 行 buffer 归零后未配对重置跟踪器，后续摘要会停在错位内容上');
    }
});

test('流式 afterRender 必须走增量版（不得每帧全文 split）', () => {
    const fnStart = message.indexOf('function appendReasonChunkCore');
    assert.ok(fnStart > 0);
    const fnEnd = message.indexOf('\nfunction ', fnStart + 10);
    const body = message.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
    assert.ok(/setPreviewLineIncremental\(/.test(body), '思考流式路径必须调用增量版');
    assert.ok(!/setPreviewLine\(h\.thinkingBlockEl/.test(body),
        '思考流式路径不得调用全量版（每帧对全文 split，O(n²) 分配）');
});

test('收敛定稿走全量版：给整轮增量路径上一道自检', () => {
    const fnStart = message.indexOf('function finishThinkingBlockCore');
    assert.ok(fnStart > 0);
    const body = message.slice(fnStart, message.indexOf('\nfunction ', fnStart + 10));
    assert.ok(/setPreviewLine\(h\.thinkingBlockEl/.test(body),
        '收敛帧应走全量取行，把定稿摘要校正到权威值');
});

test('被引用的测试文件真实存在（杜绝「由 xxx.test.js 覆盖」的虚假承诺）', () => {
    /* 本文件的诞生理由：tool-body-lazy-build.test.js 的注释声称
       「预览行为由 linear-flow-readability.test.js 真实测试」，而该文件当时并不存在，
       预览逻辑处于零覆盖状态却看起来已被测（绿色假象）。此断言防止同类情况复发。 */
    const other = fs.readFileSync(path.join(__dirname, 'tool-body-lazy-build.test.js'), 'utf8');
    const refs = [...other.matchAll(/([\w-]+\.test\.js)/g)].map(m => m[1]);
    assert.ok(refs.length > 0, '未在被引用文件里找到测试文件名引用');
    for (const r of new Set(refs)) {
        assert.ok(fs.existsSync(path.join(__dirname, r)),
            'tool-body-lazy-build.test.js 注释里引用的 ' + r + ' 不存在 = 虚假覆盖承诺');
    }
});

/* =====================================================================
   5. 参数摘要信息密度（折叠态下头部是唯一的语义承载位）
   ===================================================================== */
test('bash 单参数免 key= 前缀：命令本体占满可见宽度（等价 Codex 的 `Ran npm test`）', () => {
    assert.equal(api.formatToolArgsStr({ command: 'mvn -q test' }), 'mvn -q test');
});

test('语义优先级排序：command 不得被 timeout/run_in_background 挤到截断线之后', () => {
    /* 旧实现按 Object.keys 原序拼，bash 长命令被同级的 timeout 挤到 80 字符外，
       用户读到的是「timeout=120000」这种无意义前缀——正是「不点开就看不懂」的成因。 */
    const s = api.formatToolArgsStr({ timeout: 120000, run_in_background: false, command: 'npm run build --watch' });
    assert.ok(s.indexOf('command=') === 0, 'command 必须排在最前，实际: ' + s);
    assert.ok(s.indexOf('npm run build') > 0);
});

test('多键才加 key= 前缀；单键让本体独占（前缀会吃掉宝贵的可见宽度）', () => {
    assert.equal(api.formatToolArgsStr({ pattern: 'TODO' }), 'TODO');
    const multi = api.formatToolArgsStr({ pattern: 'TODO', path: 'src', include: '*.js' });
    assert.ok(/pattern=TODO/.test(multi), '多键需消歧: ' + multi);
});

test('抑制与头部其他元素重复的键：file_path/path 已由 .tool-file 展示', () => {
    const s = api.formatToolArgsStr({ file_path: 'src/App.java', offset: 10, limit: 50 });
    assert.ok(!s.includes('src/App.java'), 'file_path 不应重复出现在参数摘要里: ' + s);
    assert.ok(/offset=10/.test(s), '其余键保留');
});

test('抑制大体积键：diff/content/todos 由卡体渲染器专门展示', () => {
    const s = api.formatToolArgsStr({ file_path: 'a.js', content: 'x'.repeat(5000), diff: 'y'.repeat(5000) });
    assert.equal(s, '', '全部键都被抑制时应返回空串，不得把大体积内容塞进头部');
});

test('字符串数组展开内容：只报个数等于什么都没显示', () => {
    const s = api.formatToolArgsStr({ files: ['a.js', 'b.js'] });
    assert.ok(s.includes('a.js') && s.includes('b.js'), '应展开数组内容: ' + s);
    const many = api.formatToolArgsStr({ files: ['a', 'b', 'c', 'd', 'e'] });
    assert.ok(/\+2/.test(many), '超过 3 项应计数收尾: ' + many);
});

test('对象数组仍退化为计数（展开会产生噪声）', () => {
    const s = api.formatToolArgsStr({ tasks: [{ index: 1 }, { index: 2 }] });
    assert.ok(/2\s*项/.test(s), '对象数组应报个数: ' + s);
});

test('参数摘要长度受 ARG_MAX_CHARS 限制并以省略号收尾', () => {
    const s = api.formatToolArgsStr({ command: 'z'.repeat(5000) });
    assert.equal(s.length, api.ARG_MAX_CHARS);
    assert.ok(s.endsWith('…'));
});

test('换行折成空格并去首尾空白（头部是单行，不得出现换行）', () => {
    const s = api.formatToolArgsStr({ command: '  line1\nline2  ' });
    assert.equal(s, 'line1 line2');
    assert.ok(!s.includes('\n'));
});

test('空/非对象入参返回空串（不得抛错）', () => {
    assert.equal(api.formatToolArgsStr(null), '');
    assert.equal(api.formatToolArgsStr(undefined), '');
    assert.equal(api.formatToolArgsStr('str'), '');
    assert.equal(api.formatToolArgsStr({}), '');
});

/* =====================================================================
   6. CSS 契约（验行为，不锁属性顺序）
   ===================================================================== */
function ruleBlock(css, selector) {
    /* 提取首个匹配选择器的规则块。不断言「首属性是什么」——那是脆弱护栏，
       属性顺序一变就误报（本仓库已因此返工过一次）。 */
    const idx = css.indexOf(selector + ' {');
    assert.ok(idx >= 0, 'CSS 中未找到规则: ' + selector);
    const open = css.indexOf('{', idx);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}
/* 宽松版：分组选择器（逗号分隔）中，非末位选择器后面跟的是 ',' 而非 ' {'，
   严格版会找不到；此版只要求选择器存在，取其后首个 {…} 块。 */
function ruleBlockLoose(css, selector) {
    const idx = css.indexOf(selector);
    assert.ok(idx >= 0, 'CSS 中未找到规则: ' + selector);
    const open = css.indexOf('{', idx);
    assert.ok(open >= 0, '选择器后未找到声明块: ' + selector);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}
/* 独立规则版：行首锚定（允许缩进），专抓「.xxx { ... }」形态的规则本体。
   indexOf 会被嵌套选择器里的同类片段骗到（如 .agent-card-body > .thinking-block
   先于 .thinking-block 出现），必须用正则锚定选择器是整个选择器的开头。 */
function ruleBlockStandalone(css, selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(^|\\r?\\n)[ \\t]*' + esc + '[ \\t]*\\{').exec(css);
    assert.ok(m, 'CSS 中未找到独立规则: ' + selector);
    const open = css.indexOf('{', m.index);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
}
test('.tool-args 不再 display:none（折叠态头部是唯一的语义承载位）', () => {
    const block = ruleBlock(appCss, ' .tool-args');
    assert.ok(!/display:\s*none/.test(block), '头部参数摘要被隐藏 = 回到「必须点开才知道调用了什么」');
    assert.ok(/display:\s*block/.test(block));
    assert.ok(/text-overflow:\s*ellipsis/.test(block), '单行截断需要省略号');
});

test('展开态隐藏预览（避免与卡体首行重复；预览在 header 内，两态高度不变）', () => {
    for (const sel of ['.tool-card.expanded .tool-card-header .tool-card-preview',
                      '.thinking-block.expanded .thinking-block-header .thinking-block-preview']) {
        const block = ruleBlockLoose(appCss, sel);
        assert.ok(/display:\s*none/.test(block), sel + ' 应在展开后隐藏');
    }
});

test('预览是单行截断（标题行内弹性收缩，不得把标题行撑高）', () => {
    const block = ruleBlockLoose(appCss, '.tool-card-header .preview-inline');
    assert.ok(/white-space:\s*nowrap/.test(block), '必须单行');
    assert.ok(/overflow:\s*hidden/.test(block), '必须裁切溢出');
    assert.ok(/text-overflow:\s*ellipsis/.test(block), '必须有省略号');
    assert.ok(/flex:\s*1 1 0/.test(block), '必须弹性伸缩（超长时让位给工具名）');
    assert.ok(/min-width:\s*0/.test(block), 'flex 子项必须有 min-width:0 才能收缩');
    assert.ok(/order:\s*4(?!\d|\.)/.test(block), '顺序钉在参数摘要之后、耗时/状态点之前');
    assert.ok(!/order:\s*\d+\.\d+/.test(block),
        'flex order 只接受整数：曾写 3.5 被浏览器丢弃回退为 0，预览窜到工具名之前（用户实测的展示错乱）');
});

test('预览用三级文字色 + 小字号（视觉降级为注脚，不与正文争权重）', () => {
    const block = ruleBlockLoose(appCss, '.tool-card-header .preview-inline');
    assert.ok(/color:\s*var\(--text-tertiary\)/.test(block));
    assert.ok(/font-size:\s*1[12](\.\d)?px/.test(block), '字号应小于正文（实测 12px）');
});

/* =====================================================================
   7. 过程卡视觉统一契约（2026-09-30 用户拍板：保竖条+对称 6px 圆角；
      全透明底+hover 灰底；margin 统一 2px 0）
   背景：四族过程卡曾各自为政——思考卡常驻淡底、智能体卡常驻 hover 底、
   工具卡透明；margin 2px/0 0 4px/4px 0 各不相同；单侧圆角 0 6px 6px 0 配左竖条。
   三种底色三种深浅拼在一起 + 间距不一致 = 「颜色不一致、忽高忽低」的用户抱怨。
   本区块锁住统一后的形态，防并行主题回退。
   ===================================================================== */
const PROCESS_CARDS = ['.tool-card', '.thinking-block', '.tool-batch-group', '.agent-card'];
test('四族过程卡统一：对称 6px 圆角（左竖条配单侧圆角的突兀形态不得回归）', () => {
    for (const sel of PROCESS_CARDS) {
        const block = ruleBlockStandalone(appCss, sel);
        assert.ok(/border-radius:\s*6px/.test(block), sel + ' 应为对称 6px 圆角');
        assert.ok(!/border-radius:\s*0 6px 6px 0/.test(block),
            sel + ' 不得回退为单侧圆角（左直角右弧度是用户点名的丑感来源）');
    }
});

test('四族过程卡统一：透明底 + hover 灰底（不得常驻三种深浅不一的底色）', () => {
    for (const sel of PROCESS_CARDS) {
        const block = ruleBlockStandalone(appCss, sel);
        assert.ok(/background:\s*transparent/.test(block), sel + ' 静止态应透明');
        assert.ok(!/background:\s*var\(--(thinking-block-bg|bg-hover)\)/.test(block),
            sel + ' 不得常驻淡底（思考卡 #f6f6f7 / 智能体卡 #f2f2f3 会与透明工具卡拼成色块拼盘）');
    }
});

test('四族过程卡统一：margin 2px 0（间距不一致 = 忽高忽低观感的成因之一）', () => {
    for (const sel of PROCESS_CARDS) {
        const block = ruleBlockStandalone(appCss, sel);
        assert.ok(/margin:\s*2px 0/.test(block), sel + ' 应为 2px 0');
        assert.ok(!/margin:\s*0 0 4px/.test(block), sel + ' 不得回退为思考卡旧间距');
        assert.ok(!/margin:\s*4px 0/.test(block), sel + ' 不得回退为智能体卡旧间距');
    }
});

test('code 模式不再覆盖四族过程卡本身的 margin/圆角（基线已统一，覆盖会重新制造不一致）', () => {
    const codeCss = readStatic('css', 'code.css');
    /* 只锁四张卡的独立覆盖规则；批量组内成员行的紧凑间距
       （.batch-tool-items > .tool-card { margin: 3px 0 }）是合理保留，不在本护栏范围。
       行首锚定：indexOf 会被注释或嵌套选择器里的同名片段骗到。 */
    for (const sel of PROCESS_CARDS) {
        const esc = sel.replace('.', '\\.');
        const m = new RegExp('(^|\\r?\\n)[ \\t]*body\\.code-mode #chatView ' + esc + '[ \\t]*\\{([^}]*)\\}').exec(codeCss);
        if (!m) continue;
        /* m[2] 才是规则体（m[1] 是行首锚点捕获组，拿它断言等于重验换行符，恒绿假护栏） */
        assert.ok(!/margin:/.test(m[2]), 'code.css 不得再覆盖 ' + sel + ' 的 margin（基线已统一 2px 0）');
        assert.ok(!/border-radius:/.test(m[2]), 'code.css 不得再覆盖 ' + sel + ' 的圆角（基线已统一 6px）');
    }
});

test('思考卡整卡 hover 灰底与工具卡同口径（透明底方案下 hover 是唯一的定位反馈）', () => {
    const block = ruleBlockStandalone(appCss, '.thinking-block:not(.streaming):hover');
    assert.ok(/background:\s*var\(--bg-hover\)/.test(block),
        '非流式态悬停应浮出灰底（工具卡/智能体卡均有，缺失会让思考卡「点不亮」）');
});

test('思考卡专属淡底 token 不再被 app.css 引用（防死 token 复活）', () => {
    /* --thinking-block-border 仍被思考卡体分隔线使用，仅淡底 token 应消失。 */
    const uses = [...appCss.matchAll(/--thinking-block-bg/g)].length;
    assert.equal(uses, 0, '淡底 token 不应再被 app.css 引用（透明底后已死，复活意味着回退）');
});
