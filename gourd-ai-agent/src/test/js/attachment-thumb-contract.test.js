/**
 * 契约测试：已落盘附件（uploads/xxx）的回显缩略图链路。
 *
 * 背景：队列出队与历史回放手里只有会话内相对路径，旧实现只画「图 N」数量徽标，
 * 用户看到的是一个带边框的小 chip（"弹框"观感）而不是图片。本链路把徽标升级为
 * 真实缩略图：user 帧/队列项携带 imagePaths/filePaths → 前端占位 →
 * GET /web/chat/attachment/meta 换 dataUrl → 替换为 <img>；失败合并降级回一个「图 N」徽标。
 *
 * 覆盖：
 * - app-message.js：appendUserMessage 第 6 参 attachPaths（数量徽标参数已删除）；
 *   renderUserAttachmentPaths 行为（沙箱跑真实源码）：文件瓦片先于图片容器、
 *   图片占位带 data-attach-path、meta 恰拉取一次且路径同序；
 *   renderUserAttachmentMeta 行为：全成功→img+lightbox、部分失败→合并单徽标、
 *   全失败→单徽标且无残留加载位、无 name 时 alt/title 回落文件名；
 *   userAttachNameFromPath 正反斜杠双兜底；
 *   fetchAttachmentMeta 契约：traditional 重复键传参（不再手工拼 URL）、
 *   批量常量、缓存/在途合并、失败兜底为同长全 null 数组
 * - app-ui.js：队列行图片占位改用 DOM 构建（不再字符串拼接属性）、
 *   upgradeQueueThumbs 行为（沙箱跑真实源码）：同父失败合并单徽标、跨父各出徽标；
 *   processNextQueuedMessage 把路径交给气泡（六参调用）
 * - app-history.js：回放 user/user_input 帧透传 imagePaths/filePaths
 * - app.css：缩略图/加载位/队列缩略图样式齐备，meta 升级出的 <img> 有圆角与限高限宽
 * - 后端：/web/chat/attachment/meta 端点（paramValues + 批量上限 400）、
 *   WebGate.attachmentMeta 安全校验、recordUser 七参重载落盘附件路径、WebChunk 字段
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (name) => fs.readFileSync(path.join(javaRoot, name), 'utf8');

const message = readStatic('js', 'app-message.js');
const ui = readStatic('js', 'app-ui.js');
const history = readStatic('js', 'app-history.js');
const css = readStatic('css', 'app.css');
const webController = readJava('WebController.java');
const webGate = readJava('WebGate.java');
const streamStore = readJava('SessionStreamStore.java');
const webChunk = readJava('WebChunk.java');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/* 按花括号配平抽取函数体（Java 方法同样适用：从声明处第一个 { 配平到 }） */
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

/* 剥注释后的可执行源码：产品代码注释里正引用被废弃/对比的写法
   （如「readNBytes(上限+1) 既不会…而不再 readAllBytes」、「isRegularFile 而非 exists」），
   直接对原文断言会被注释里的字串喂饱，代码真回退了也测不出来。 */
function codeOnly(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* ===== 沙箱替身：微型 DOM 桩（仓库无 jsdom），只实现被测源码用到的 API 子集 ===== */
function makeStubEl(attrs, tag) {
    return {
        tagName: String(tag || 'div').toUpperCase(),
        attrs: attrs || {},
        className: '',
        textContent: '',
        children: [],
        parentNode: null,
        getAttribute(k) { return (k in this.attrs) ? this.attrs[k] : null; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        insertBefore(c, ref) {
            const i = ref ? this.children.indexOf(ref) : -1;
            c.parentNode = this;
            if (i >= 0) this.children.splice(i, 0, c); else this.children.push(c);
            return c;
        }
    };
}
function makeParent(children) {
    return {
        children: children,
        replaceChild(nu, old) {
            const i = this.children.indexOf(old);
            assert.ok(i >= 0, 'replaceChild 的目标必须是当前子节点');
            this.children[i] = nu;
            nu.parentNode = this;
            old.parentNode = null;
        },
        removeChild(x) {
            const i = this.children.indexOf(x);
            assert.ok(i >= 0, 'removeChild 的目标必须是当前子节点');
            this.children.splice(i, 1);
            x.parentNode = null;
        }
    };
}
function makeBuilder(el) {
    const b = {
        attr(k, v) { el.attrs[k] = v; return b; },
        addClass(c) { el.className = (el.className ? el.className + ' ' : '') + c; return b; },
        text(t) { el.textContent = t; return b; }
    };
    b[0] = el;
    return b;
}
/* document 桩：队列缩略图升级链路用 createElement 建节点（不再拼 HTML 字符串） */
const documentStub = { createElement: (tag) => makeStubEl({}, tag) };

/* 在沙箱中执行真实源码的 renderUserAttachmentMeta */
function loadMetaRenderer(thumbs, lightboxSpy) {
    const src = sliceBetween(message, 'function renderUserAttachmentMeta', '/* ===== 会话附件元信息拉取');
    const nameSrc = sliceBetween(message, 'function userAttachNameFromPath', '/* 已落盘附件占位渲染');
    const parent = makeParent(thumbs);
    thumbs.forEach(t => { t.parentNode = parent; });
    const bubble = { tag: 'bubble' };
    const $ = function (arg) {
        if (arg === bubble) {
            return {
                find(sel) {
                    assert.equal(sel, '.user-attach-thumb[data-attach-path]');
                    return { each(cb) { parent.children.filter(c => c.attrs && ('data-attach-path' in c.attrs)).forEach((el, i) => cb.call(el, i, el)); } };
                }
            };
        }
        if (arg === '<img>') return makeBuilder(makeStubEl({}, 'img'));
        if (arg === '<span>') return makeBuilder(makeStubEl({}, 'span'));
        throw new Error('unexpected $ arg: ' + arg);
    };
    const GourdI18n = { t: (key, params) => key + ':' + JSON.stringify(params) };
    /* userAttachNameFromPath 必须注入：meta 回调用它把路径兜底成 alt/title，
       缺注入时该分支会在沙箱里抛 ReferenceError（且表现为「meta 没有 name 就崩」的假象） */
    const fn = new Function('$', 'GourdI18n', 'addImageLightbox', nameSrc + '\n' + src
        + '\nreturn renderUserAttachmentMeta;')($, GourdI18n, lightboxSpy);
    return { fn, parent, bubble };
}

test('行为：meta 全成功 → 占位全部替换为 img 且补绑 lightbox', () => {
    const t1 = makeStubEl({ 'data-attach-path': 'uploads/a.png' });
    const t2 = makeStubEl({ 'data-attach-path': 'uploads/b.png' });
    let lightboxCalls = 0;
    const { fn, parent, bubble } = loadMetaRenderer([t1, t2], () => { lightboxCalls++; });
    fn(bubble, [
        { path: 'uploads/a.png', dataUrl: 'data:image/png;base64,QQ==', name: 'a.png' },
        { path: 'uploads/b.png', dataUrl: 'data:image/png;base64,Qg==', name: 'b.png' }
    ]);
    assert.equal(parent.children.length, 2);
    assert.equal(parent.children[0].attrs.src, 'data:image/png;base64,QQ==');
    assert.equal(parent.children[1].attrs.src, 'data:image/png;base64,Qg==');
    assert.ok(!parent.children[0].attrs.title);
    assert.equal(parent.children[0].attrs.alt, 'a.png');
    assert.equal(lightboxCalls, 1, '成功图片必须补绑 lightbox');
});

test('行为：meta 条目无 name → alt/title 回落为路径中的文件名', () => {
    /* 后端只对图片条目写 name，异常/降级条目可能缺字段；
       缺 name 时不得把整段 uploads/x.png 路径塞进 alt/title（tooltip 观感与信息量都不对） */
    const t1 = makeStubEl({ 'data-attach-path': 'uploads/x.png' });
    const { fn, parent, bubble } = loadMetaRenderer([t1], () => {});
    fn(bubble, [{ path: 'uploads/x.png', dataUrl: 'data:image/png;base64,QQ==' }]);
    assert.equal(parent.children.length, 1);
    assert.equal(parent.children[0].attrs.alt, 'x.png', 'alt 必须回落到文件名');
    assert.ok(!parent.children[0].attrs.title, 'title 不应存在');
    assert.equal(parent.children[0].attrs.src, 'data:image/png;base64,QQ==');
});

test('行为：部分失败 → 失败占位合并为单个「图 N」徽标，成功者仍为 img', () => {
    const t1 = makeStubEl({ 'data-attach-path': 'uploads/a.png' });
    const t2 = makeStubEl({ 'data-attach-path': 'uploads/gone.png' });
    const t3 = makeStubEl({ 'data-attach-path': 'uploads/gone2.png' });
    let lightboxCalls = 0;
    const { fn, parent, bubble } = loadMetaRenderer([t1, t2, t3], () => { lightboxCalls++; });
    fn(bubble, [
        { path: 'uploads/a.png', dataUrl: 'data:image/png;base64,QQ==', name: 'a.png' },
        { path: 'uploads/gone.png', error: 'missing' },
        { path: 'uploads/gone2.png', error: 'missing' }
    ]);
    assert.equal(parent.children.length, 2, '1 img + 1 合并徽标');
    const img = parent.children.find(c => c.attrs && c.attrs.src);
    const badge = parent.children.find(c => c.className === 'user-attach-badge');
    assert.ok(img && badge, '必须同时存在 img 与降级徽标');
    assert.match(badge.textContent, /"n":2/, '徽标计数必须是失败张数 2');
    assert.equal(lightboxCalls, 1);
});

test('行为：meta 全失败（端点不可达兜底全 null）→ 单个徽标、零残留加载位', () => {
    const t1 = makeStubEl({ 'data-attach-path': 'uploads/a.png' });
    const t2 = makeStubEl({ 'data-attach-path': 'uploads/b.png' });
    let lightboxCalls = 0;
    const { fn, parent, bubble } = loadMetaRenderer([t1, t2], () => { lightboxCalls++; });
    fn(bubble, [null, null]);
    assert.equal(parent.children.length, 1, '两个占位必须合并成一个徽标，不得各发一个「图 1」');
    assert.equal(parent.children[0].className, 'user-attach-badge');
    assert.match(parent.children[0].textContent, /"n":2/);
    assert.equal(lightboxCalls, 0, '无成功图片不得绑 lightbox');
    assert.equal(parent.children.filter(c => c.attrs && ('data-attach-path' in c.attrs)).length, 0,
        '不得残留永远转圈的加载位');
});

test('纯函数：userAttachNameFromPath 去目录前缀（正反斜杠双兜底）', () => {
    const src = sliceBetween(message, 'function userAttachNameFromPath', '/* 已落盘附件占位渲染');
    const fn = new Function(src + '\nreturn userAttachNameFromPath;')();
    assert.equal(fn('uploads/pasted-image-abc.png'), 'pasted-image-abc.png');
    assert.equal(fn('pasted-image-abc.png'), 'pasted-image-abc.png');
    assert.equal(fn(''), '');
    assert.equal(fn(null), '');
    /* Windows 端上报或后端拼接的路径可能是反斜杠：只按 '/' 切会带出整段目录，
       必须取两种分隔符中最后出现的那个 */
    assert.equal(fn('uploads\\pasted-image-abc.png'), 'pasted-image-abc.png');
    assert.equal(fn('D:\\work\\uploads\\a.png'), 'a.png');
    assert.equal(fn('uploads/mixed\\a.png'), 'a.png');
    assert.match(src, /Math\.max\(p\.lastIndexOf\('\/'\), p\.lastIndexOf\('\\\\'\)\)/,
        '必须用 Math.max 取两种分隔符的最后位置');
});

/* ===== 行为：renderUserAttachmentPaths 占位渲染（真实源码进沙箱） ===== */

function loadPathRenderer(fetchStub, metaStub) {
    const src = sliceBetween(message, 'function userAttachNameFromPath', '/* meta 回调');
    const bubble = makeStubEl({}, 'div');
    const $ = function (arg) {
        if (typeof arg === 'string') {
            const m = arg.match(/^<(\w+)>$/);
            assert.ok(m, '不支持的构造选择器: ' + arg);
            return makeBuilder(makeStubEl({}, m[1]));
        }
        if (arg === bubble) {
            return { append(node) { bubble.appendChild(node); return this; } };
        }
        throw new Error('unexpected $ arg: ' + arg);
    };
    const GourdI18n = { t: (key, params) => key + ':' + JSON.stringify(params) };
    const fn = new Function('$', 'GourdI18n', 'escapeHtml', 'fileIconSvg',
        'fetchAttachmentMeta', 'renderUserAttachmentMeta',
        src + '\nreturn renderUserAttachmentPaths;')(
        $, GourdI18n, s => String(s), () => '<svg/>', fetchStub, metaStub);
    return { fn, bubble };
}

test('行为：renderUserAttachmentPaths（3 图 1 文件）→ 文件瓦片先出、图片占位 3 个、meta 恰拉一次', async () => {
    const fetchCalls = [];
    const metaCalls = [];
    const { fn, bubble } = loadPathRenderer(
        (sessOrId, paths) => { fetchCalls.push({ sessOrId, paths }); return Promise.resolve([{ path: paths[0] }]); },
        (b, items) => { metaCalls.push({ bubble: b, items }); });
    const sess = { sessionId: 's1' };
    const imgs = ['uploads/a.png', 'uploads/b.png', 'uploads/c.png'];
    const files = ['uploads/report.pdf'];
    fn(sess, bubble, imgs, files);

    // ① 文件瓦片容器必须先于图片容器（名称即可读，无需等 meta）
    assert.equal(bubble.children.length, 2, '必须恰好两个容器：文件瓦片 + 图片占位');
    const fileWrap = bubble.children[0];
    const imgWrap = bubble.children[1];
    assert.match(fileWrap.className, /user-attach-files/, '首个容器必须是文件瓦片容器');
    assert.match(imgWrap.className, /user-attach-imgs/, '第二个容器必须是图片容器');
    assert.ok(bubble.children.indexOf(fileWrap) < bubble.children.indexOf(imgWrap),
        '文件瓦片必须先于图片容器渲染');

    // ② 文件瓦片：1 个，带路径锚点，名称已去目录前缀
    assert.equal(fileWrap.children.length, 1);
    assert.equal(fileWrap.children[0].getAttribute('data-attach-path'), 'uploads/report.pdf');
    assert.match(fileWrap.children[0].className, /user-attach-file/);

    // ③ 图片占位：3 个，每个都是加载态且带路径锚点（供 meta 回调精确替换）
    const placeholders = imgWrap.children.filter(c => c.getAttribute('data-attach-path') != null);
    assert.equal(placeholders.length, 3, '3 张图必须出 3 个带 data-attach-path 的占位');
    assert.equal(imgWrap.children.length, 3, '图片容器里不得混入其它节点');
    placeholders.forEach((ph, i) => {
        assert.match(ph.className, /user-attach-thumb/, '占位必须是缩略图位');
        assert.match(ph.className, /loading/, '占位必须是加载态（meta 回来前给用户可见反馈）');
        assert.equal(ph.getAttribute('data-attach-path'), imgs[i], '占位顺序必须与入参路径同序');
    });

    // ④ meta 恰拉取一次，且入参路径同序（不得按占位逐个发请求）
    assert.equal(fetchCalls.length, 1, '一组附件只允许发一次 meta 请求');
    assert.equal(fetchCalls[0].sessOrId, sess, '必须把会话对象透传给 meta 拉取（root 取会话工作空间）');
    assert.deepEqual(fetchCalls[0].paths, imgs, 'meta 入参必须与图片路径同序同长');

    // ⑤ meta 结果必须接到 renderUserAttachmentMeta 完成替换/降级
    await new Promise(r => setTimeout(r, 0));
    assert.equal(metaCalls.length, 1, 'meta 回来后必须走替换/降级回调');
    assert.equal(metaCalls[0].bubble, bubble, '回调必须作用于同一个气泡');
    assert.deepEqual(metaCalls[0].items, [{ path: imgs[0] }]);
});

test('行为：renderUserAttachmentPaths 只有文件时不发 meta 请求', () => {
    let fetchCalls = 0;
    const { fn, bubble } = loadPathRenderer(() => { fetchCalls++; return Promise.resolve([]); }, () => {});
    fn({ sessionId: 's1' }, bubble, [], ['uploads/a.txt']);
    assert.equal(fetchCalls, 0, '纯文件附件没有 dataUrl 可换，不得发请求');
    assert.equal(bubble.children.length, 1);
    assert.match(bubble.children[0].className, /user-attach-files/);
});

/* ===== 行为：upgradeQueueThumbs（真实源码进沙箱） ===== */

/* upgradeQueueThumbs 的 $list / sessionId 是它自己的形参，注入的是它依赖的全局
   （fetchAttachmentMeta / GourdI18n / document / addImageLightbox），两者不得混淆。 */
function loadQueueUpgrader(items) {
    const src = sliceBetween(ui, 'function upgradeQueueThumbs', 'async function processMessageQueue');
    const fetchPaths = [];
    let lightboxCalls = 0;
    const GourdI18n = { t: (key, params) => key + ':' + JSON.stringify(params) };
    const fn = new Function('fetchAttachmentMeta', 'GourdI18n', 'document', 'addImageLightbox',
        src + '\nreturn upgradeQueueThumbs;')(
        (sessionId, paths) => { fetchPaths.push({ sessionId, paths }); return Promise.resolve(items); },
        GourdI18n, documentStub, () => { lightboxCalls++; });
    return { fn, fetchPaths, lightboxCalls: () => lightboxCalls };
}
/* $list 桩：只实现 upgradeQueueThumbs 用到的 find(...).length / .each */
function makeListStub(els) {
    return {
        find(sel) {
            assert.equal(sel, '.queue-attach-thumb[data-attach-path]', '必须按类 + 路径锚点选占位');
            return {
                length: els.length,
                each(cb) { els.forEach((el, i) => cb.call(el, i, el)); }
            };
        }
    };
}

test('行为：upgradeQueueThumbs 同父 3 占位（1 成功 2 失败）→ 1 img + 1 个 n=2 徽标', async () => {
    const parent = makeParent([]);
    const p1 = makeStubEl({ 'data-attach-path': 'uploads/ok.png' });
    const p2 = makeStubEl({ 'data-attach-path': 'uploads/gone.png' });
    const p3 = makeStubEl({ 'data-attach-path': 'uploads/gone2.png' });
    [p1, p2, p3].forEach(el => { parent.children.push(el); el.parentNode = parent; });
    const { fn, fetchPaths, lightboxCalls } = loadQueueUpgrader([
        { path: 'uploads/ok.png', dataUrl: 'data:image/png;base64,QQ==', name: 'ok.png' },
        { path: 'uploads/gone.png', error: 'missing' },
        null
    ]);
    fn(makeListStub([p1, p2, p3]), 'sess-1');
    assert.equal(fetchPaths.length, 1, '整列只允许一次 meta 请求');
    assert.equal(fetchPaths[0].sessionId, 'sess-1', '队列面板只有 sessionId 字符串，必须原样透传');
    assert.deepEqual(fetchPaths[0].paths, ['uploads/ok.png', 'uploads/gone.png', 'uploads/gone2.png'],
        '请求路径必须与占位同序');

    await new Promise(r => setTimeout(r, 0));
    assert.equal(parent.children.length, 2, '1 img + 1 合并徽标');
    const img = parent.children.find(c => c.className === 'queue-attach-img');
    const badge = parent.children.find(c => c.className === 'queue-attach-badge');
    assert.ok(img, '成功者必须替换为 22px 缩略图');
    assert.equal(img.tagName, 'IMG', '必须是 createElement("img") 建出的真实节点');
    assert.equal(img.src, 'data:image/png;base64,QQ==');
    assert.equal(img.alt, 'ok.png');
    assert.ok(badge, '失败者必须合并为一个降级徽标');
    assert.match(badge.textContent, /"n":2/, '徽标计数必须是失败张数 2');
    assert.equal(lightboxCalls(), 1, '队列缩略图也要可点开看大图');
    assert.equal(parent.children.filter(c => c.className === 'queue-attach-thumb').length, 0,
        '面板不得残留加载位');
});

test('行为：upgradeQueueThumbs 跨两个 queue-item 各 1 失败 → 各出 1 个徽标（不跨组合并）', async () => {
    const parentA = makeParent([]);
    const parentB = makeParent([]);
    const a1 = makeStubEl({ 'data-attach-path': 'uploads/a1.png' });
    const b1 = makeStubEl({ 'data-attach-path': 'uploads/b1.png' });
    parentA.children.push(a1); a1.parentNode = parentA;
    parentB.children.push(b1); b1.parentNode = parentB;
    const { fn } = loadQueueUpgrader([
        { path: 'uploads/a1.png', error: 'missing' },
        null
    ]);
    fn(makeListStub([a1, b1]), 'sess-2');
    await new Promise(r => setTimeout(r, 0));

    assert.equal(parentA.children.length, 1, 'A 组只能有一个徽标');
    assert.equal(parentB.children.length, 1, 'B 组只能有一个徽标');
    const badgeA = parentA.children[0];
    const badgeB = parentB.children[0];
    assert.equal(badgeA.className, 'queue-attach-badge');
    assert.equal(badgeB.className, 'queue-attach-badge');
    assert.ok(badgeA !== badgeB, '两个队列项的徽标必须是各自独立的节点，不得跨组合并');
    assert.match(badgeA.textContent, /"n":1/);
    assert.match(badgeB.textContent, /"n":1/);
    assert.equal(badgeA.parentNode, parentA, '徽标必须落在自己所属的 queue-item 内');
    assert.equal(badgeB.parentNode, parentB);
});

test('行为：upgradeQueueThumbs 无占位时不发请求', () => {
    const { fn, fetchPaths } = loadQueueUpgrader([]);
    fn(makeListStub([]), 'sess-3');
    assert.equal(fetchPaths.length, 0, '没有图片占位不得发 meta 请求');
});

/* ===== 源码/契约护栏 ===== */

test('app-message.js：appendUserMessage 第 6 参 attachPaths（数量徽标参数已删除）', () => {
    const sig = message.match(/function appendUserMessage\(([^)]*)\)/);
    assert.ok(sig, 'appendUserMessage 签名必须存在');
    const params = sig[1].split(',').map(s => s.trim());
    assert.equal(params.length, 6, '签名必须是 6 参：attachCounts 徽标参数已随缩略图链路删除');
    assert.deepEqual(params, ['sess', 'text', 'imageDataUrls', 'fileAttachments', 'createdAt', 'attachPaths']);
    assert.equal(params[5], 'attachPaths', '第 6 参必须是 attachPaths（缩略图链路入口）');
    const body = sliceBetween(message, 'function appendUserMessage', '/* 用户消息气泡的复制按钮绑定');
    assert.ok(body.indexOf('attachCounts') < 0, '函数体内不得再引用已删除的 attachCounts');
    assert.ok(body.indexOf('user-attach-counts') < 0, '数量徽标容器不得再由 appendUserMessage 直接画');
    assert.match(body, /renderUserAttachmentPaths\(sess, bubble, attachPaths\.imagePaths \|\| \[\], attachPaths\.filePaths \|\| \[\]\)/,
        '有路径必须走缩略图链路');
    assert.match(body, /if \(attachPaths && \(\(attachPaths\.imagePaths \|\| \[\]\)\.length \|\| \(attachPaths\.filePaths \|\| \[\]\)\.length\)\)/,
        '必须先判空再进缩略图链路');
    // 复制按钮必须走共用实现（不再内联一份点击逻辑）
    assert.match(body, /bindUserMsgCopyBtn\(\$\(row\)\.find\('\.user-copy-btn'\)\[0\], bubble\)/);
    assert.match(message, /window\.bindUserMsgCopyBtn = bindUserMsgCopyBtn;/, '共用实现必须挂 window');
    // 调用点必须同步为 6 参（旧的第 6 参徽标对象会让路径落到 attachCounts 位上被静默丢弃）
    assert.ok(history.indexOf('{ images:') < 0, 'app-history.js 不得再传数量徽标对象');
    assert.ok(ui.indexOf('{ images: imagePaths.length, files: filePaths.length }') < 0,
        'app-ui.js 不得再传数量徽标对象');
});

test('app-message.js：占位渲染契约（路径锚点 + 加载态 + 文件瓦片）', () => {
    const render = sliceBetween(message, 'function renderUserAttachmentPaths', '/* meta 回调');
    assert.match(render, /setAttribute\('data-attach-path'/, '占位必须带路径锚点供回调替换');
    assert.match(render, /addClass\('user-attach-thumb loading'\)/, '图片占位必须是加载态');
    assert.match(render, /fetchAttachmentMeta\(sess, imagePaths\)\.then/, '图片占位必须触发 meta 拉取');
    assert.match(render, /addClass\('user-attach-file'\)/, '文件直接出瓦片');
    assert.match(render, /escapeHtml\(userAttachNameFromPath\(filePaths\[i\]\)\)/,
        '文件名必须转义后再入 HTML（附件名可含尖括号/引号）');
});

test('app-message.js：fetchAttachmentMeta 用 traditional 重复键传参，不再手工拼 URL', () => {
    const fetchFn = sliceBetween(message, 'function fetchAttachmentMeta', 'function appendSystemNotice');
    assert.match(fetchFn, /url: '\/web\/chat\/attachment\/meta'/, 'URL 必须是纯端点，不带手工拼接的 query');
    assert.ok(fetchFn.indexOf('?sessionId=') < 0, '不得再手工拼 ?sessionId=（多图会撞 URL 长度上限）');
    assert.ok(fetchFn.indexOf("paths.join(',')") < 0, '不得再把 paths 逗号拼进 URL');
    assert.match(fetchFn, /traditional: true/, '必须用 jQuery traditional：paths 以重复键传，后端按 paramValues 取全量');
    assert.match(fetchFn, /data: \{ sessionId: sid, root: root \|\| '', paths: batchPaths \}/,
        '参数必须走 data 交由 jQuery 序列化');
    assert.match(fetchFn, /dataType: 'json'/);
    assert.match(message, /var ATTACH_META_BATCH_SIZE = 12;/, '每批路径上限常量必须是 12');
    assert.match(fetchFn, /b \+= ATTACH_META_BATCH_SIZE/, '必须按批量常量分批请求');
    assert.match(fetchFn, /var results = new Array\(total\);/, '返回值必须是与入参同长同序的数组');
    assert.match(fetchFn, /results\[k\] = attachMetaCache\[key\];/, '命中缓存的路径直接回填，不再发请求');
    assert.match(fetchFn, /inflight: attachMetaInflight\[key\] \|\| null/, '同 key 在途请求必须合并');
    assert.match(fetchFn, /attachMetaInflight\[slot\.key\] = p;/, '每个路径必须登记独立的在途 Promise 供后到者复用');
    assert.match(fetchFn, /if \(cur\.inflight\) \{/, '命中在途的 slot 不得再发一次请求');
    assert.match(fetchFn, /if \(got && !got\.error\) attachMetaCache\[group\[n\]\.key\] = got;/,
        '带 error 的条目不得写缓存（否则失败结果被永久钉住，刷新也不重试）');
    assert.match(fetchFn, /delete attachMetaInflight\[slot\.key\]/, 'in-flight 必须在 settle 时释放');
    assert.match(fetchFn, /for \(var n = 0; n < group\.length; n\+\+\) out\.push\(null\);/,
        '整批失败必须兜底为全 null（不是空数组），由调用方按 null 降级');
    assert.match(fetchFn, /return Promise\.all\(jobs\)\.then\(function\(\) \{\s*\n\s*return results;\s*\n\s*\}, function\(\) \{\s*\n\s*return results;/,
        '成功与失败两条路径都必须返回同序数组，绝不抛异常打断渲染');
    assert.match(fetchFn, /typeof sessOrId === 'object'/, '必须兼容会话对象与 sessionId 字符串两种入参');
    assert.match(fetchFn, /rootFor\(sessOrId\)/, '会话对象入参：root 走 rootFor（与回放/删除同口径）');
    assert.match(fetchFn, /getSessionCwd\(\)/, '字符串入参：root 走 getSessionCwd');
    assert.match(message, /function attachMetaKey\(sid, path\) \{\s*\n\s*return sid \+ '\\u0001' \+ path;/,
        '缓存键必须是 sid + \\u0001 + path（不同会话的同名附件不得串图）');
});

test('app-ui.js：队列行图片占位改用 DOM 构建（不再字符串拼接属性）', () => {
    const render = sliceBetween(ui, 'function renderQueueContainer', '/* 队列面板图片缩略图升级');
    /* 路径直接拼进 HTML 属性是注入面：含引号/尖括号的文件名会撕开标签结构。
       必须改为 createElement + setAttribute。 */
    assert.ok(render.indexOf('queue-attach-thumb" data-attach-path=') < 0,
        '不得再用字符串拼接 data-attach-path 属性');
    assert.match(render, /document\.createElement\('span'\)/, '占位必须用 createElement 构建');
    assert.match(render, /thumbEl\.className = 'queue-attach-thumb'/);
    assert.match(render, /thumbEl\.setAttribute\('data-attach-path', imagePaths\[ip\]\)/,
        '路径必须走 setAttribute（属性值由 DOM 转义，不经字符串拼接）');
    assert.doesNotMatch(render, /queue-attach-badge">' \+ GourdI18n\.t\('queue\.images'/,
        '图片数量徽标只能作为降级产物，不得在首渲染直接画');
    assert.match(render, /upgradeQueueThumbs\(\$list, sessionId\)/, '列表构建后必须触发缩略图升级');
    assert.match(render, /attachWrap\.insertBefore\(thumbEl, attachAnchor\)/,
        '占位必须插在文件计数徽标之前（与旧版视觉位置一致）');

    const upgrade = sliceBetween(ui, 'function upgradeQueueThumbs', 'async function processMessageQueue');
    assert.match(upgrade, /fetchAttachmentMeta\(sessionId, paths\)/, '整列一次 meta 请求');
    assert.match(upgrade, /img\.className = 'queue-attach-img'/, '成功替换为缩略图（DOM 构建）');
    assert.match(upgrade, /document\.createElement\('img'\)/);
    assert.match(upgrade, /GourdI18n\.t\('queue\.images', \{ n: els\.length \}\)/, '失败按同组合并为单徽标');
    assert.match(upgrade, /failedGroups\[g\]\.parent === parent/, '合并分组必须按父节点隔离，不得跨 queue-item 合并');
    assert.match(upgrade, /addImageLightbox\(parent\)/, '队列缩略图必须补绑 lightbox');
    assert.match(upgrade, /if \(!\$thumbs\.length\) return;/, '无占位必须早退，不发请求');
});

test('app-ui.js：队列出队气泡携带附件路径（六参调用）', () => {
    const dequeue = sliceBetween(ui, 'async function processNextQueuedMessage', '// 等待目标会话发送完成');
    assert.match(dequeue, /appendUserMessage\(guardSess, displayText, null, null, null,\s*\n?\s*\{ imagePaths: imagePaths, filePaths: filePaths \}\)/,
        '出队气泡必须把路径放在第 6 参 attachPaths 位上（缩略图升级入口）');
    assert.ok(dequeue.indexOf('{ images:') < 0, '不得再传已删除的数量徽标参数');
});

test('app-history.js：回放 user 帧透传附件路径（六参调用）', () => {
    const replay = sliceBetween(history, "if (chunk.type === 'user' || chunk.type === 'user_input') {", "if (chunk.type === 'done')");
    assert.match(replay, /chunk\.imagePaths \|\| \[\]/);
    assert.match(replay, /chunk\.filePaths \|\| \[\]/);
    assert.match(replay, /\{ imagePaths: rpImages, filePaths: rpFiles \} : null/,
        '旧帧无路径字段时必须传 null（保持纯文本气泡）');
    assert.match(replay, /appendUserMessage\(sess, chunk\.text, null, null, chunk\.createdAt,/);
    assert.ok(replay.indexOf('{ images:') < 0, '回放不得再传已删除的数量徽标参数');
});

test('app-streaming.js：实时 user 帧走同一 appendUserMessage 签名（5 参调用）', () => {
    const streamingJs = readStatic('js', 'app-streaming.js');
    assert.match(streamingJs, /appendUserMessage\(userSess, chunk\.text, null, null, chunk\.createdAt\);/,
        '无附件的 5 参调用必须与 6 参签名兼容（attachPaths 省略即 undefined）');
    assert.match(streamingJs, /appendUserMessage\(sess, displayText, imageDataUrls, fileAttachments\);/,
        '本地直传路径（dataUrl/File）仍走 4 参调用，不经落盘缩略图链路');
    assert.ok(streamingJs.indexOf('{ images:') < 0, 'app-streaming.js 不得再传已删除的数量徽标参数');
});

test('app-message.js：addImageLightbox 选择器覆盖队列缩略图', () => {
    const lightbox = fnBody(message, 'addImageLightbox');
    assert.match(lightbox, /\.user-attach-imgs img/, '气泡附件图必须可点开');
    assert.match(lightbox, /\.queue-attach-img/, '队列面板 22px 缩略图必须可点开');
    assert.match(lightbox, /\.md-content img/, '正文图必须可点开');
    assert.match(lightbox, /if \(\$\(imgs\[i\]\)\.data\('lightbox'\)\) continue;/,
        '必须有幂等守卫（同一容器会被多张图重复调用）');
    assert.match(message, /window\.addImageLightbox = addImageLightbox;/, '必须挂 window 供 app-ui.js 调用');
});

test('app.css：缩略图与加载位样式齐备（含圆角与限高限宽）', () => {
    assert.match(css, /\.user-attach-thumb \{/);
    assert.match(css, /\.user-attach-thumb\.loading::after/);
    assert.match(css, /\.user-attach-files \{/);
    assert.match(css, /\.queue-attach-thumb \{/);
    assert.match(css, /\.queue-attach-img \{/);
    assert.match(css, /@keyframes spin \{/, '加载位动画依赖既有 spin 关键帧');
    // meta 升级出的 <img> 无内联尺寸约束，必须有统一限高限宽规则，否则大图撑爆气泡
    assert.match(css, /\.user-attach-imgs img \{[^}]*max-height: 120px/);
    assert.match(css, /\.user-attach-imgs img \{[^}]*max-width: 200px/);
    assert.match(css, /\.user-attach-imgs img \{[^}]*object-fit: cover/);
    /* 圆角必须与同气泡内 dataUrl 直渲的图（内联 border-radius:8px）一致，
       否则同一批附件里「本地直传图」与「落盘回显图」观感不同（一个圆角一个直角） */
    assert.match(css, /\.user-attach-imgs img \{[^}]*border-radius: 8px/,
        'meta 升级出的 img 必须有 8px 圆角');
    assert.match(message, /border-radius:8px;object-fit:cover;/,
        'dataUrl 直渲路径的内联样式必须与 CSS 规则同口径');
});

test('后端：meta 端点与安全校验契约', () => {
    assert.match(webController, /@Mapping\("\/web\/chat\/attachment\/meta"\)/);
    assert.match(webController, /validateSessionId\(sessionId\)/);
    assert.match(webController, /webGate\.attachmentMeta\(sessionDir, wanted\)/);
    /* paths 是重复表单键（前端 jQuery traditional 传参）：必须用 paramValues 取全量，
       @Param 单值绑定只会拿到其中一个，多图时静默丢附件 */
    assert.match(webController, /ctx\.paramValues\("paths"\)/);
    assert.match(webController, /private static final int ATTACHMENT_META_MAX_PATHS = 32;/);
    assert.match(webController, /Result\.failure\(400, "TOO_MANY_PATHS"\)/,
        '超批量上限必须 400 TOO_MANY_PATHS（明确契约优于静默截断）');
    /* 常量声明与失败分支各自存在 ≠ 两者真接上了：必须断言超限判定确实用了这个常量
       并确实返回这个错误码，否则把 if 条件改成 if(false) 也能让上面两条全部通过。 */
    assert.match(webController, /if \(wanted\.size\(\) > ATTACHMENT_META_MAX_PATHS\) \{\s*\n\s*return Result\.failure\(400, "TOO_MANY_PATHS"\);/,
        '超限判定必须直接引用 ATTACHMENT_META_MAX_PATHS 并返回 TOO_MANY_PATHS');
    const meta = sliceBetween(webGate, 'List<Map<String, Object>> attachmentMeta(', 'static String extensionToMime');
    const metaCode = codeOnly(meta);
    assert.match(meta, /sanitizeAttachmentPath\(raw\)/, '非法路径必须走 sanitize 校验');
    assert.match(meta, /!file\.startsWith\(uploadsRoot\)/, '越界路径必须拒绝');
    assert.match(metaCode, /java\.nio\.file\.Files\.isRegularFile\(file\)/,
        '必须用 isRegularFile 而非 exists（目录/设备/失效链接都归为 missing）');
    assert.ok(metaCode.indexOf('Files.exists(file)') < 0, '不得回退为 Files.exists（目录会被当成可读附件）');
    assert.match(meta, /row\.put\("error", "missing"\)/, '缺失文件以 error 条目返回，不整批失败');
    assert.match(meta, /META_IMAGE_MAX_BYTES/, '超大图片只回元信息，前端降级');
    assert.match(meta, /META_DATAURL_BUDGET_BYTES/, '必须有整批 dataUrl 字节预算，防巨型响应体');
    /* 必须对可执行源码断言：readNBytes 与 readAllBytes 都在方法注释里被提及过 */
    assert.match(metaCode, /in\.readNBytes\(\(int\) Math\.min\(META_IMAGE_MAX_BYTES \+ 1, Integer\.MAX_VALUE\)\)/,
        '必须带上限流式读 readNBytes(MAX+1)：不把超限文件读进内存，又能确实判出超限');
    assert.ok(metaCode.indexOf('readAllBytes') < 0, '不得回退为 readAllBytes（TOCTOU + 超限文件全量进内存）');
    assert.match(metaCode, /if \(bytes\.length > META_IMAGE_MAX_BYTES\)/, '读回字节超限必须再判一次');
    assert.match(meta, /"data:" \+ extensionToMime\(ext\) \+ ";base64,"/, 'dataUrl 口径与注入链路一致');
    assert.match(meta, /row\.put\("path", raw\)/, '每个条目都必须带 path，否则前端占位永远等不到结果');
});

test('后端：user 帧落盘附件路径（历史回放可还原），空清单归一 null', () => {
    assert.match(webChunk, /private List<String> imagePaths;/);
    assert.match(webChunk, /private List<String> filePaths;/);
    assert.match(streamStore, /public void recordUser\(String sessionId, String projectRoot, String text, long createdAt,\s*\n?\s*String clientMessageId, List<String> imagePaths, List<String> filePaths\)/);
    /* 空清单必须归一为 null：序列化器对 null 字段不输出键，但会把空 List 写成
       "imagePaths":[]，使无附件的普通发言与旧格式逐字节不一致 */
    assert.match(streamStore, /uc\.setImagePaths\(imagePaths == null \|\| imagePaths\.isEmpty\(\) \? null : imagePaths\);/);
    assert.match(streamStore, /uc\.setFilePaths\(filePaths == null \|\| filePaths\.isEmpty\(\) \? null : filePaths\);/);
    const gate = sliceBetween(webGate, 'static void collectAttachmentPaths(', 'static boolean isImageAttachment');
    assert.ok(gate.includes('name.contains("..")') && gate.includes('name.contains("\\\\")'),
        'multipart 附件名非法形态必须跳过（与主链路同口径）');
    assert.match(gate, /sanitizeAttachmentPath\(attachmentPaths\.get\(i\)\)/, '路径引用必须过 sanitize');
    const input = sliceBetween(webGate, 'if (clientMessageId != null && Assert.isEmpty(hitlAction) && Assert.isNotEmpty(input)', 'if (source != null && Assert.isEmpty(hitlAction)) {');
    /* multipart 部分只记「确实落盘成功」的路径（savedImagePaths/savedFilePaths），
       故 collectAttachmentPaths 的前两个参数传 null，只消费按路径引用的那部分。 */
    assert.match(input, /List<String> recImagePaths = new ArrayList<>\(savedImagePaths\);/,
        '落盘成功的图片路径必须汇入落盘清单');
    assert.match(input, /List<String> recFilePaths = new ArrayList<>\(savedFilePaths\);/,
        '落盘成功的文件路径必须汇入落盘清单');
    assert.match(input, /collectAttachmentPaths\(null, null, attachmentPaths, attachmentPathTypes,\s*\n?\s*recImagePaths, recFilePaths\);/,
        '按路径引用的附件必须汇入同一对清单（multipart 已单独落盘，不重复记）');
    assert.match(input, /streamStore\.recordUser\(sessionId, streamRoot, input, System\.currentTimeMillis\(\), clientMessageId,\s*\n?\s*recImagePaths, recFilePaths\)/);
});
