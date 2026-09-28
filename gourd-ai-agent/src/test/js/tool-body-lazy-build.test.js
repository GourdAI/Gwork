/**
 * 契约测试：工具卡折叠态结果体延迟构建（懒构建）。
 *
 * 为什么需要它（实测依据）：改造前折叠工具卡 100% 已把结果体构建进 DOM
 * （work-mtsg8z30 20/20、work-muck13j8 25/25），仅靠 display:none 隐藏；
 * 节点创建 / diff 逐行着色 / innerHTML 解析成本全额付出，而绝大多数卡用户从不点开。
 * 改造后实测 DOM 节点 1887→529、768→378。
 *
 * 覆盖：
 * - app-message.js 真实区块在沙箱中执行的行为（非源码字符串比对）：
 *   折叠态只暂存不构建 / 展开态立即构建（HITL 顺序陷阱）/ toggle 首展构建且重开不重复构建 /
 *   渲染器抛错时暂存必须清掉（不得永远停在待构建）/ 构建后必须补 highlightCodeBlocks /
 *   fillToolBody 收到的参数与入参一致
 * - 四处建卡路径的 toggle 都补了 ensureToolCardBody（漏一处就是「点开是空的」）
 * - CSS：卡体默认 display:none，展开态才 block（懒构建的可见性前提）
 *
 * 变异验证（.tmp/mutcheck_lazy_body.js）：把 toggle 里的 ensureToolCardBody 去掉、
 * 或把 highlightCodeBlocks 调用去掉，本测试必须失败。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const message = readStatic('js', 'app-message.js');
const appCss = readStatic('css', 'app.css');

/* 提取真实源码区块（懒构建 helper + updateToolCardContent）
   【坑】不能用固定的 end marker：本文件是 CRLF，写 'return bareToolName;\n}' 永远匹不上；
   而只切到 'return bareToolName;' 又会把 updateToolCardContent 的闭合大括号留在外面，
   得到一段语法不完整的代码（表现为 7 个沙箱用例全报 SyntaxError: Unexpected token ')'，
   很像「真实缺陷」其实是脚手架 bug）。故先定位末语句，再往后找第一个 '}' 作为函数收尾。 */
function sliceLazyBlock(source) {
    const startMarker = '/* ===== 折叠态卡体延迟构建';
    const endMarker = 'return bareToolName;';
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, '未找到懒构建区块起始标记');
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, '未找到 updateToolCardContent 收尾语句');
    const close = source.indexOf('}', end + endMarker.length);
    assert.ok(close > end, '未找到函数闭合大括号');
    return source.slice(start, close + 1);
}
const lazyBlock = sliceLazyBlock(message);

/* 区块自身必须语法完整（防后人改动后又切出半截代码，报一堆难懂的 SyntaxError） */
test('懒构建区块提取完整：能被解析为合法 JS', () => {
    assert.doesNotThrow(() => new Function('window', '$', 'GourdI18n', 'fillToolBody', 'highlightCodeBlocks',
        'applyToolPresentation', 'updateToolHeaderMeta', 'formatToolArgsStr', 'setPreviewLine', lazyBlock),
        '提取的区块必须是语法完整的代码块');
    ['ensureToolCardBody', 'setToolBodyPending', 'bindToolCardToggle', 'updateToolCardContent']
        .forEach(fn => assert.match(lazyBlock, new RegExp('function ' + fn + '\\('), fn + ' 应在区块内'));
});

/* ===== 微型 DOM / jQuery 桩：只实现本区块用到的 API ===== */
function makeEl(tag, className) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        className: className || '',
        children: [],
        parentNode: null,
        childNodes: [],
        style: { removeAttribute() { el._styleAttr = (el._styleAttr || []).filter(() => false); } },
        _innerHTML: '',
        _attrs: {},
        _handlers: {}
    };
    /* className 与 classList 必须双向同步：ensureToolCardBody 读 classList.contains('expanded')，
       而 toggleClass 走 className。两者不同步的话「展开态立即构建」这条路径永远测不到。 */
    el.classList = {
        contains(c) { return (' ' + el.className + ' ').indexOf(' ' + c + ' ') >= 0; },
        add(c) { if (!el.classList.contains(c)) el.className = (el.className ? el.className + ' ' : '') + c; },
        remove(c) { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
        toggle(c) { el.classList.contains(c) ? el.classList.remove(c) : el.classList.add(c); }
    };
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._innerHTML; },
        set(v) {
            el._innerHTML = v;
            /* 空串清空子节点；非空串造一个子节点，让 childNodes.length 能反映「已构建」 */
            el.childNodes = v === '' ? [] : [{}];
            el.children = el.childNodes;
        }
    });
    el.appendChild = (c) => { c.parentNode = el; el.children.push(c); el.childNodes.push(c); return c; };
    el.setAttribute = (k, v) => { el._attrs[k] = String(v); };
    el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null);
    el.removeAttribute = (k) => { delete el._attrs[k]; };
    el.addEventListener = (type, fn) => { (el._handlers[type] = el._handlers[type] || []).push(fn); };
    el.click = () => { (el._handlers.click || []).forEach(fn => fn({ stopPropagation() {} })); };
    /* 按 class 选择器查子孙（桩够用即可） */
    el._findByClass = (cls) => {
        const out = [];
        const walk = (n) => { (n.children || []).forEach(c => { if (c.classList && c.classList.contains(cls)) out.push(c); walk(c); }); };
        walk(el);
        return out;
    };
    return el;
}
function $(arg) {
    /* 字符串入参 = 构造新元素（$('<span>')）；元素入参 = 包装。
       必须支持链式 .addClass().text().insertAfter()：updateToolCardContent 在
       缺 .tool-args 时走这条链，桩不全就会报 text is not a function（脚手架 bug，非源码缺陷）。 */
    if (typeof arg === 'string') {
        const m = /^<(\w+)>$/.exec(arg.trim());
        if (m) return $(makeEl(m[1]));
    }
    const els = typeof arg === 'string' ? [] : [arg];
    const api = {
        length: els.length,
        0: els[0],
        find(sel) {
            const cls = String(sel).replace(/^\./, '');
            const found = [];
            els.forEach(e => { if (e && e._findByClass) found.push(...e._findByClass(cls)); });
            const sub = { length: found.length, 0: found[0] };
            sub.first = () => ({
                length: found.length, 0: found[0],
                on: (t, fn) => { found.forEach(e => e.addEventListener(t, fn)); return sub; },
                text: (v) => { if (found[0]) found[0].textContent = v; return sub; },
                addClass: (c) => { found.forEach(e => e.classList.add(c)); return sub; }
            });
            sub.on = (t, fn) => { found.forEach(e => e.addEventListener(t, fn)); return sub; };
            sub.each = (fn) => { found.forEach((e, i) => fn.call(e, i)); return sub; };
            sub.text = (v) => { found.forEach(e => { e.textContent = v; }); return sub; };
            sub.addClass = (c) => { found.forEach(e => e.classList.add(c)); return sub; };
            return sub;
        },
        first() { return api; },
        on(t, fn) { els.forEach(e => e.addEventListener(t, fn)); return api; },
        toggleClass(c) { els.forEach(e => e.classList.toggle(c)); return api; },
        addClass(c) { els.forEach(e => e.classList.add(c)); return api; },
        removeClass(c) { els.forEach(e => e.classList.remove(c)); return api; },
        text(v) { els.forEach(e => { e.textContent = v; }); return api; },
        /* insertAfter(target)：插到目标节点之后（target 可能是元素或包装对象） */
        insertAfter(target) {
            const t = target && target[0] ? target[0] : target;
            const parent = t && t.parentNode;
            els.forEach(e => {
                if (parent) { parent.children.push(e); parent.childNodes.push(e); e.parentNode = parent; }
            });
            return api;
        }
    };
    return api;
}
/* 造一张带 header + 空 body 的工具卡（与 createToolCardShell 的 DOM 形状一致） */
function makeCard(opts) {
    opts = opts || {};
    const card = makeEl('div', 'tool-card' + (opts.expanded ? ' expanded' : ''));
    const header = makeEl('div', 'tool-card-header');
    const name = makeEl('span', 'tool-name');
    header.appendChild(name);
    const body = makeEl('div', 'tool-card-body');
    card.appendChild(header);
    card.appendChild(body);
    return { card, header, body, name };
}

function createSandbox(opts) {
    opts = opts || {};
    const calls = { fillToolBody: [], highlight: [], preview: [] };
    const env = { rendererThrows: !!opts.rendererThrows };

    const factory = new Function(
        'window', '$', 'GourdI18n', 'fillToolBody', 'highlightCodeBlocks',
        'applyToolPresentation', 'updateToolHeaderMeta', 'formatToolArgsStr', 'setPreviewLine',
        lazyBlock + '\nreturn { ensureToolCardBody: ensureToolCardBody, setToolBodyPending: setToolBodyPending,'
        + ' bindToolCardToggle: bindToolCardToggle, updateToolCardContent: updateToolCardContent };'
    );
    const win = {};
    const api = factory(
        win, $,
        { t: (k, p) => (p && p.length ? k + '#' + p.join(',') : k) },
        function (sess, bodyEl, toolName, text, args, meta) {
            calls.fillToolBody.push({ sess, bodyEl, toolName, text, args, meta });
            if (env.rendererThrows) throw new Error('renderer boom');
            /* 模拟真实渲染器：往 body 里塞一个代码块节点（todowrite 渲染器会产出 pre>code.hljs） */
            const code = makeEl('code', 'hljs language-markdown');
            const pre = makeEl('pre');
            pre.appendChild(code);
            bodyEl.appendChild(pre);
            return true;
        },
        function (container) { calls.highlight.push(container); },
        function (cardEl, toolName, toolTitle, options) { return { bareToolName: toolName, source: null, displayName: toolName }; },
        function () {},
        function (args) { return args ? JSON.stringify(args).slice(0, 30) : ''; },
        /* 折叠态预览行（零点击可读）：本文件只测「卡体是否构建」，预览行为由
           linear-flow-readability.test.js 真实测试，此处给可记调用次数的桩。 */
        function (hostEl, cls, text, fromEnd) { calls.preview.push({ hostEl, cls, text, fromEnd }); }
    );
    return { api, calls, win };
}

/* ===== 行为测试 ===== */

test('折叠态：只暂存渲染参数，不构建卡体（懒构建生效的核心）', () => {
    const { api, calls } = createSandbox();
    const { card, body } = makeCard({ expanded: false });
    const sess = { sessionId: 's1' };

    api.setToolBodyPending(card, sess, 'todowrite', 'RESULT_TEXT', { todos: 'x' }, { truncated: false });

    assert.equal(calls.fillToolBody.length, 0, '折叠态不得构建卡体');
    assert.equal(body.childNodes.length, 0, '折叠态卡体必须是空的（基线为 100% 已构建）');
    assert.ok(card._pendingToolBody, '渲染参数必须暂存，否则展开时无据可依');
    assert.equal(card._pendingToolBody.text, 'RESULT_TEXT');
});

test('展开态：立即构建（HITL 复用分支的顺序陷阱）', () => {
    const { api, calls } = createSandbox();
    const { card, body } = makeCard({ expanded: true });
    const sess = { sessionId: 's1' };

    api.setToolBodyPending(card, sess, 'edit', 'DIFF', { diff: '@@' }, null);

    assert.equal(calls.fillToolBody.length, 1, '展开态必须立即构建，否则「展开档下卡体是空的」');
    assert.equal(calls.fillToolBody[0].text, 'DIFF');
    assert.ok(body.childNodes.length > 0, '卡体应已填充');
    assert.equal(card._pendingToolBody, null, '构建后暂存必须清掉');
});

test('toggle：首展构建，重开不重复构建，文本不丢', () => {
    const { api, calls } = createSandbox();
    const { card, header, body } = makeCard({ expanded: false });
    api.bindToolCardToggle(card);
    api.setToolBodyPending(card, { sessionId: 's1' }, 'read', 'FILE_CONTENT', {}, null);
    assert.equal(calls.fillToolBody.length, 0);

    /* 必须点 header 而不是 card：事件绑定在 .tool-card-header 上，
       桩没有事件冒泡（真实浏览器靠冒泡才能点到，所以浏览器实测时也是点 header）。 */
    header.click();   /* 展开 */
    assert.ok(card.classList.contains('expanded'), '点击后应处于展开态');
    assert.equal(calls.fillToolBody.length, 1, '首次展开必须构建卡体');
    const childrenAfterBuild = body.childNodes.length;
    assert.ok(childrenAfterBuild > 0, '卡体应已填充');

    header.click();   /* 收起 */
    assert.equal(card.classList.contains('expanded'), false);
    header.click();   /* 再展开 */
    assert.equal(calls.fillToolBody.length, 1, '重复展开不得再次构建（暂存已清）');
    assert.equal(body.childNodes.length, childrenAfterBuild, '重开后内容不得丢失或被清空');
});

test('构建后必须补 highlightCodeBlocks（否则 todowrite 的 hljs 代码块永不高亮）', () => {
    const { api, calls } = createSandbox();
    const { card, body } = makeCard({ expanded: true });
    api.setToolBodyPending(card, { sessionId: 's1' }, 'todowrite', 'MD', {}, null);

    assert.equal(calls.highlight.length, 1, '构建后必须调用一次 highlightCodeBlocks');
    assert.equal(calls.highlight[0], body, '高亮范围必须是刚构建的卡体');
});

test('渲染器抛错时暂存必须清掉（不得永远停在待构建而反复重试）', () => {
    const { api, calls } = createSandbox({ rendererThrows: true });
    const { card } = makeCard({ expanded: true });
    /* 异常传播行为与改造前一致（旧实现也是在 updateToolCardContent 里直接调 fillToolBody，
       不在本层吞错），故用 try/finally 包住：这里要守的契约是「不得留下永久待构建态」，
       而不是「不得抛错」。吞掉错误反而会把真实渲染故障隐埋成静默空白。 */
    let threw = null;
    try {
        api.setToolBodyPending(card, { sessionId: 's1' }, 'bash', 'OUT', {}, null);
    } catch (e) { threw = e; }

    assert.equal(calls.fillToolBody.length, 1, '渲染器应被调用一次');
    assert.ok(threw, '渲染器异常应与改造前一致地向上传播（不得静默吞掉）');
    assert.equal(card._pendingToolBody, null, '抛错后暂存也必须清空，否则每次展开都会重试');
    /* 再点展开不得再调渲染器（暂存已清） */
    api.ensureToolCardBody(card);
    assert.equal(calls.fillToolBody.length, 1, '暂存已清后不得重复构建');
});

test('fillToolBody 参数透传：sess / bareToolName / text / args / meta 不得错位', () => {
    const { api, calls } = createSandbox();
    const { card } = makeCard({ expanded: true });
    const sess = { sessionId: 'S', projectRoot: '/r' };
    const args = { file_path: 'a.js' };
    const meta = { truncated: true, seq: 42, fullLength: 9999 };

    const bare = api.updateToolCardContent(sess, card, 'TerminalTalent/bash', '标题', args, 'TXT', meta, {});
    assert.equal(bare, 'TerminalTalent/bash', 'applyToolPresentation 的 bareToolName 应原样返回');
    assert.equal(calls.fillToolBody.length, 1);
    const c = calls.fillToolBody[0];
    assert.equal(c.sess, sess);
    assert.equal(c.toolName, 'TerminalTalent/bash');
    assert.equal(c.text, 'TXT');
    assert.equal(c.args, args);
    assert.equal(c.meta, meta, 'meta 丢了就点不出「展开全文」按钮');
});

test('ensureToolCardBody：无暂存 / 无卡体 / 折叠态 三种情况都不得抛错', () => {
    const { api } = createSandbox();
    const bare = makeEl('div', 'tool-card');            /* 没有 body */
    assert.equal(api.ensureToolCardBody(bare), false);
    assert.equal(api.ensureToolCardBody(null), false);
    const { card } = makeCard({ expanded: false });      /* 有 body 但没暂存 */
    assert.equal(api.ensureToolCardBody(card), false);
});

/* ===== 源码接线护栏：四处建卡路径都走 bindToolCardToggle ===== */
/* 历史教训：第一版实现把四处 toggle 写成内联（各自补 ensureToolCardBody），
   却抽了一个零调用的 bindToolCardToggle 函数——死代码 + 注释误导（声称已抽取），
   而当时的扫描式测试测的正是这个死函数（绿色假象）。现四处均改为真实调用。
   为何仍扫描而非只测函数：扫描能同时抦住「函数体漏补构建」与「某处退回内联但漏补」
   两种回归；只测函数体则后者测不到。 */
test('四处建卡路径均调用 bindToolCardToggle，且函数体内补了构建', () => {
    /* 1) 调用点：骨架卡 / 批量兜底卡 / 正式卡 / HITL 卡 共 4 处 */
    const callSites = message.match(/bindToolCardToggle\(\w+\);/g) || [];
    assert.equal(callSites.length, 4,
        `应有 4 处 bindToolCardToggle 调用（骨架/兜底/正式/HITL），实际 ${callSites.length}`);
    /* 2) 函数定义全仓唯一，且体内必须同时切类与补构建 */
    const defs = message.match(/function bindToolCardToggle\(card\) \{/g) || [];
    assert.equal(defs.length, 1, '定义应唯一（防重复定义后者覆盖前者）');
    const fnStart = message.indexOf('function bindToolCardToggle(card) {');
    const fnEnd = message.indexOf('\n}', fnStart);
    assert.ok(fnEnd > fnStart, 'bindToolCardToggle 函数体定位失效');
    const fnBody = message.slice(fnStart, fnEnd);
    assert.match(fnBody, /\.tool-card-header'\)\.on\('click'/, '应绑定在 .tool-card-header 的 click 上');
    assert.match(fnBody, /toggleClass\('expanded'\)/, 'handler 必须切换 expanded 类');
    assert.match(fnBody, /ensureToolCardBody\(card\)/, 'handler 必须补一次卡体构建，否则懒构建卡展开为空');
    /* 3) 不得再残留内联 toggle（退回内联容易漏补构建，正是抽函数的动机） */
    const inline = message.match(/\.tool-card-header'\)\.on\('click'/g) || [];
    assert.equal(inline.length, 1, '内联 .tool-card-header click 绑定应只剩 bindToolCardToggle 内一处');
});

test('思考块/批量分组/子代理卡的 toggle 不得被误接 ensureToolCardBody', () => {
    /* 这三类卡的结果体不经 updateToolCardContent，接上会是无意义的空转；
       更重要的是防「为了过上面那条测试而把全部 toggle 无脑改一遍」的过度修正。 */
    [['.thinking-block-header', /\$\(block\)\.find\('\.thinking-block-header'\)\.on\('click', function\(\) \{([\s\S]*?)\}\);/],
     ['.tool-batch-header', /\.tool-batch-header'\)\.on\('click', function\(\) \{([\s\S]*?)\}\);/],
     ['.agent-card-header', /\.agent-card-header'\)\.on\('click', function\(\) \{([\s\S]*?)\}\);/]
    ].forEach(([name, re]) => {
        const m = message.match(re);
        assert.ok(m, name + ' 的 toggle 绑定应存在');
        assert.doesNotMatch(m[1], /ensureToolCardBody\(/, name + ' 不是工具卡，不应接工具卡体构建');
        assert.doesNotMatch(m[1], /bindToolCardToggle\(/, name + ' 不是工具卡，不应走工具卡 toggle 绑定');
    });
});

test('HITL 复用分支：ensureToolCardBody 必须在 expanded 类切换【之后】', () => {
    /* 变异验证抓到的盲区（M6）：本测试集原本只覆盖了 toggle 与直接调
       updateToolCardContent 的路径，而 HITL 审批卡复用分支是【先填内容、后加 expanded 类】：
           updateToolCardContent(...)        ← 此时卡还未展开，只会暂存
           if (cliPrintSimplified === false) $(rc).addClass('expanded')
           ensureToolCardBody(rc)            ← 缺这一行，展开档下卡体永远是空的
       这个顺序陷阱在默认折叠档下看不出来（反正看不到卡体），只在用户把
       「打印简化」切到展开档时暴雲，极难被发现。 */
    const branchStart = message.indexOf('// 复用分支：若刚批准过 HITL');
    assert.ok(branchStart >= 0, '未找到 HITL 复用分支');
    const branchEnd = message.indexOf('advanceBodyPointer(sess, sess,', branchStart);
    assert.ok(branchEnd > branchStart, 'HITL 分支边界定位失效');
    const branch = message.slice(branchStart, branchEnd);

    const fillIdx = branch.indexOf('updateToolCardContent(');
    const expandIdx = branch.indexOf("addClass('expanded')");
    const ensureIdx = branch.indexOf('ensureToolCardBody(rc)');
    assert.ok(fillIdx >= 0, '分支内应有内容回填');
    assert.ok(expandIdx > fillIdx, 'expanded 类应在回填之后才加上（这就是顺序陷阱的前提）');
    assert.ok(ensureIdx > expandIdx,
        'ensureToolCardBody(rc) 必须在 addClass(expanded) 之后，否则展开档下卡体为空');
    /* 折叠档也必须回到同一口径：removeClass 分支同样需要它（无暂存时是空转，无害） */
    assert.match(branch, /removeClass\('expanded'\);/, '折叠档分支应保留，避免只处理展开档');
});

test('updateToolCardContent 不得再无条件构建卡体', () => {
    /* 局部切片：只取该函数体（上方 lazyBlock 已验证过语法完整性） */
    const s = message.indexOf('function updateToolCardContent(');
    assert.ok(s >= 0);
    const e = message.indexOf('return bareToolName;', s);
    assert.ok(e > s);
    const fn = message.slice(s, e);
    assert.doesNotMatch(fn, /fillToolBody\(/, '直接调 fillToolBody 就绕过了懒构建');
    assert.match(fn, /setToolBodyPending\(cardEl, sess, bareToolName, text, args, meta\);/);
    /* 卡体元素仍必须在模板里存在（CSS 用 .expanded .tool-card-body 控制可见性） */
    assert.match(message, /<div class="tool-card-body"><\/div>/, 'shell 模板必须保留空卡体容器');
});

test('CSS：卡体默认隐藏、展开态才显示（懒构建的可见性前提）', () => {
    /* 传入【未转义】的选择器，转义由 rule() 内部统一做；
       预先写 \\. 会被二次转义成 \\\\. 而永远匹配不到（上一版就是这么挂的）。 */
    function rule(sel) {
        const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = appCss.match(new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}'));
        assert.ok(m, sel + ' 规则应存在');
        return m[1];
    }
    assert.match(rule('.tool-card-body'), /display:\s*none/, '折叠态卡体必须 display:none');
    assert.match(rule('.tool-card.expanded .tool-card-body'), /display:\s*block/, '展开态必须 block');
});
