/**
 * 粘贴文件入队 —— 行为级测试（非正则契约测试）。
 *
 * 为什么必须存在：attachment-and-submit-contract.test.js 全是「读源码 + 正则」断言，
 * 只验证字符串是否出现，不验证行为。变异验证实测：把修复逐个回退成 8 个变异体，
 * 只有 1 个被杀死（早退条件那条），其余全部 SURVIVED —— 包括「只收 image/*」这个
 * 原始 bug 本身。正则测试给了虚假安全感。
 *
 * 本测试把 handlePaste 及其依赖从真实源码切片出来，放进 vm 沙箱配 stub 全局执行，
 * 直接观测 pendingFiles 的真实结果与 preventDefault / showToast 调用。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_UI = path.resolve(__dirname, '../../main/resources/static/js/app-ui.js');

/**
 * 从源码按花括号配对切出顶层函数（含签名与完整函数体）。
 * 注意：本文件行尾为 CRLF，锚点里不要写 '\n' 字面量（会永不匹配）。
 */
function sliceFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `未找到函数：${signature}`);
    let i = source.indexOf('{', start);
    assert.ok(i >= 0, `函数 ${signature} 缺少函数体`);
    let depth = 0;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return source.slice(start, i + 1);
}

const SRC = fs.readFileSync(APP_UI, 'utf8');

// handlePaste 依赖的 4 个函数全部取自真实源码，不重写（重写就等于测自己的假设）
const SANDBOX_SRC = [
    sliceFunction(SRC, 'function getFileExtension('),
    sliceFunction(SRC, 'function generateUniqueFile('),
    sliceFunction(SRC, 'function processSelectedFile('),
    sliceFunction(SRC, 'function processSelectedFiles('),
    sliceFunction(SRC, 'function insertTextAtCursor('),
    sliceFunction(SRC, 'function handlePaste('),
].join('\n\n');

// 自检：切片结果必须能被解析（曾因漏掉闭合大括号导致 7 个用例假报 SyntaxError）
test('沙箱切片可被解析（防止脚手架自身制造假失败）', () => {
    assert.doesNotThrow(() => new vm.Script(SANDBOX_SRC), '切片源码存在语法错误，测试脚手架失效');
    assert.ok(SANDBOX_SRC.includes('function handlePaste('), '应包含 handlePaste');
    assert.ok(SANDBOX_SRC.includes('function processSelectedFiles('), '应包含 processSelectedFiles');
});

/**
 * 建一个沙箱，返回可控的全局桩。
 * opts.files 里 push 的对象可被断言检查。
 */
function makeSandbox(opts = {}) {
    const pendingFiles = [];
    const toasts = [];
    const calls = [];

    // FileReader 桩：图片走异步路径。用微任务触发 onload，测试内 await tick 即可。
    class FakeFileReader {
        readAsDataURL(file) {
            this.result = 'data:' + (file.type || 'application/octet-stream') + ';base64,AAAA';
            Promise.resolve().then(() => { if (this.onload) this.onload({ target: { result: this.result } }); });
        }
    }

    const sandbox = {
        pendingFiles,
        MAX_ATTACHMENTS: opts.max ?? 10,
        _pendingFilesVersion: 0,
        FileReader: FakeFileReader,
        File: class FakeFile {
            constructor(parts, name, o = {}) { this.name = name; this.type = o.type || ''; this.size = (parts && parts[0] && parts[0].length) || 0; }
        },
        showToast: (msg, kind) => toasts.push({ msg, kind }),
        GourdI18n: { t: (k, ...a) => k + ':' + JSON.stringify(a) },
        autoResize: () => {},
        renderAttachments: () => calls.push('renderAttachments'),
        $: () => ({ trigger: () => calls.push('trigger:input') }),
        console,
        Date, Math, JSON, String, Number, Array, Object, Promise, Uint8Array,
        __toasts: toasts, __calls: calls,
    };
    vm.createContext(sandbox);
    new vm.Script(SANDBOX_SRC).runInContext(sandbox);
    sandbox.__pendingFiles = pendingFiles;
    return sandbox;
}

// ── clipboardData 桩 ─────────────────────────────────────────────
function makeItem(kind, type, file) {
    return { kind, type, getAsFile: () => file };
}
function fakeFile(name, type, size = 8) {
    return { name, type, size };
}
/** 标准 clipboardData：items + files + getData */
function clipboardData({ items = [], files = [], plain = '', html = '' } = {}) {
    return {
        items,
        files,
        getData: (t) => (t === 'text/plain' ? plain : t === 'text/html' ? html : ''),
        types: ['Files'],
    };
}
function makePasteEvent(cd, target) {
    return {
        clipboardData: cd,
        target: target ?? { value: '', selectionStart: 0, selectionEnd: 0 },
        _prevented: false,
        preventDefault() { this._prevented = true; },
    };
}
const tick = () => new Promise(r => setImmediate(r));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── 核心场景 ─────────────────────────────────────────────────────

test('粘贴非图片文件（xlsx）必须入队为 file 附件 —— 原始 bug 本体', async () => {
    const sb = makeSandbox();
    const ev = makePasteEvent(clipboardData({
        items: [makeItem('file', XLSX, fakeFile('report.xlsx', XLSX))],
        files: [fakeFile('report.xlsx', XLSX)],
    }));
    sb.handlePaste(ev);
    await tick();
    assert.strictEqual(ev._prevented, true, '必须 preventDefault 才能接管粘贴');
    assert.strictEqual(sb.__pendingFiles.length, 1, `应入队 1 个附件，实际 ${sb.__pendingFiles.length}`);
    assert.strictEqual(sb.__pendingFiles[0].type, 'file');
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'file');
    assert.match(sb.__pendingFiles[0].name, /^pasted-file-\d+-\w+\.xlsx$/, '文件名应带 pasted-file 前缀与 xlsx 后缀');
});

test('粘贴 PDF 同样入队（不得只认 image/*）', async () => {
    const sb = makeSandbox();
    const f = fakeFile('doc.pdf', 'application/pdf');
    sb.handlePaste(makePasteEvent(clipboardData({ items: [makeItem('file', 'application/pdf', f)], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1);
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'file');
    assert.match(sb.__pendingFiles[0].name, /\.pdf$/);
});

test('MIME 为空的未知类型文件也要入队，后缀退化为 dat', async () => {
    const sb = makeSandbox();
    const f = fakeFile('weirdfile', '');
    sb.handlePaste(makePasteEvent(clipboardData({ items: [makeItem('file', '', f)], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1);
    assert.match(sb.__pendingFiles[0].name, /\.dat$/, '无后缀且 MIME 为空时应退化为 .dat');
});

test('clipboard.items 为空但 files 有值时仍须入队（部分 WebView 兼容兜底）', async () => {
    const sb = makeSandbox();
    const f = fakeFile('onlyfiles.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({ items: [], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1,
        'items 空而 files 有值时不得吞掉文件（Safari/旧 WebView 的 items 支持不完整）');
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'file');
});

test('粘贴图片仍走 image 路径（回归对照，不得因新增 otherFiles 桶而退化）', async () => {
    const sb = makeSandbox();
    const f = fakeFile('shot.png', 'image/png');
    sb.handlePaste(makePasteEvent(clipboardData({ items: [makeItem('file', 'image/png', f)], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1);
    assert.strictEqual(sb.__pendingFiles[0].type, 'image');
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'image');
    assert.ok(sb.__pendingFiles[0].dataUrl, '图片应带 dataUrl 预览');
});

test('图片 + 非图片同时粘贴：两者都入队且类型分流正确', async () => {
    const sb = makeSandbox();
    const img = fakeFile('a.png', 'image/png');
    const xls = fakeFile('b.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', 'image/png', img), makeItem('file', XLSX, xls)],
        files: [img, xls],
    })));
    await tick(); await tick();
    assert.strictEqual(sb.__pendingFiles.length, 2, '图片与文件应同时入队');
    const kinds = sb.__pendingFiles.map(x => x.attachmentsType).sort();
    assert.deepStrictEqual(kinds, ['file', 'image'], '应分别标记为 file 与 image');
});

test('多个非图片文件全部入队（不得只取第一个）', async () => {
    const sb = makeSandbox();
    const files = [fakeFile('a.xlsx', XLSX), fakeFile('b.pdf', 'application/pdf'), fakeFile('c.zip', 'application/zip')];
    sb.handlePaste(makePasteEvent(clipboardData({
        items: files.map(f => makeItem('file', f.type, f)),
        files,
    })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 3, '3 个文件应全部入队');
    // 入队后文件会被 generateUniqueFile 改名为 pasted-file-<时间戳>-<随机>.<后缀>，
    // 原名不保留 → 只能断言后缀与顺序，不能断言原名。
    const exts = sb.__pendingFiles.map(x => x.name.split('.').pop());
    assert.deepStrictEqual(exts, ['xlsx', 'pdf', 'zip'], '后缀应与源文件一致且保持顺序');
    assert.ok(sb.__pendingFiles.every(x => x.attachmentsType === 'file'), '全部应标为 file 附件');
});

// ── 纯文本 / 混合场景 ────────────────────────────────────────────

test('纯文本粘贴不接管（保住原生 undo 栈与 IME），也不入队任何附件', async () => {
    const sb = makeSandbox();
    const ev = makePasteEvent(clipboardData({
        items: [makeItem('string', 'text/plain', null)],
        files: [],
        plain: 'hello world',
    }));
    sb.handlePaste(ev);
    await tick();
    assert.strictEqual(ev._prevented, false, '纯文本粘贴必须交还浏览器原生行为');
    assert.strictEqual(sb.__pendingFiles.length, 0);
});

test('kind=string 的项不得被当作文件（getAsFile 返回 null 时不得崩溃/入队）', async () => {
    const sb = makeSandbox();
    const ev = makePasteEvent(clipboardData({
        items: [makeItem('string', 'text/plain', null), makeItem('string', 'text/html', null)],
        files: [],
        plain: 'plain',
        html: '<b>plain</b>',
    }));
    sb.handlePaste(ev);
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 0, 'string 项 getAsFile() 为 null，不得产生附件');
    assert.strictEqual(ev._prevented, true, '有 html 时应接管');
});

test('从资源管理器复制文件（Windows CF_HDROP）：文件入队且 textarea 不被误写入', async () => {
    // 实测确认：Windows 下 Set-Clipboard -Path 后 Get-Clipboard -Raw 为空，
    // 即 CF_HDROP 与 CF_UNICODETEXT 相互独立，text/plain 不会带出文件路径。
    const sb = makeSandbox();
    const target = { value: '', selectionStart: 0, selectionEnd: 0 };
    const f = fakeFile('report.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', XLSX, f)], files: [f], plain: '',
    }), target));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1);
    assert.strictEqual(target.value, '', '文件粘贴不得往 textarea 写任何文本');
});

test('图文混合粘贴：文字先落地，图片再入队（不得吞掉文字）', async () => {
    const sb = makeSandbox();
    const target = { value: 'existing ', selectionStart: 9, selectionEnd: 9 };
    const img = fakeFile('a.png', 'image/png');
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', 'image/png', img), makeItem('string', 'text/plain', null)],
        files: [img],
        plain: 'hello',
        html: '<p>hello</p>',
    }), target));
    await tick();
    assert.strictEqual(target.value, 'existing hello', '纯文本必须先落地到光标处');
    assert.strictEqual(sb.__pendingFiles.length, 1, '图片同时入队');
});

// ── 名额边界 ─────────────────────────────────────────────────────

test('名额已满时粘贴非图片文件：不入队且提示 attachment_limit', async () => {
    const sb = makeSandbox({ max: 10 });
    for (let i = 0; i < 10; i++) sb.__pendingFiles.push({ type: 'file', name: 'pre' + i, size: 1, attachmentsType: 'file' });
    const f = fakeFile('new.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({ items: [makeItem('file', XLSX, f)], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 10, '满额时不得继续入队');
    assert.ok(sb.__toasts.some(t => String(t.msg).includes('attachment_limit')),
        '应提示 attachment_limit，实际 toasts=' + JSON.stringify(sb.__toasts));
});

test('名额只剩 1 而粘贴 2 个文件：只受理 1 个并提示 partial_limit', async () => {
    const sb = makeSandbox({ max: 10 });
    for (let i = 0; i < 9; i++) sb.__pendingFiles.push({ type: 'file', name: 'pre' + i, size: 1, attachmentsType: 'file' });
    const a = fakeFile('a.xlsx', XLSX), b = fakeFile('b.pdf', 'application/pdf');
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', XLSX, a), makeItem('file', 'application/pdf', b)], files: [a, b],
    })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 10, '名额只剩 1，应只受理 1 个');
    assert.ok(sb.__toasts.some(t => String(t.msg).includes('attachment_partial_limit')),
        '应提示「部分未添加」，实际 toasts=' + JSON.stringify(sb.__toasts));
});

test('名额只剩 1 而粘贴 1 图 + 1 文件：总数不得超限（图片 push 是异步的）', async () => {
    const sb = makeSandbox({ max: 10 });
    for (let i = 0; i < 9; i++) sb.__pendingFiles.push({ type: 'file', name: 'pre' + i, size: 1, attachmentsType: 'file' });
    const img = fakeFile('a.png', 'image/png'), xls = fakeFile('b.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', 'image/png', img), makeItem('file', XLSX, xls)], files: [img, xls],
    })));
    await tick(); await tick();
    assert.ok(sb.__pendingFiles.length <= 10,
        `异步 FileReader 回调不得突破名额上限，实际 ${sb.__pendingFiles.length}`);
});

// ── 防御 ─────────────────────────────────────────────────────────

test('clipboardData 缺失时直接返回，不抛异常', () => {
    const sb = makeSandbox();
    assert.doesNotThrow(() => sb.handlePaste({ clipboardData: null, target: null, preventDefault() {} }));
    assert.strictEqual(sb.__pendingFiles.length, 0);
});

test('getAsFile() 返回 null 的项被跳过（不产生空附件、不崩溃）', async () => {
    const sb = makeSandbox();
    const good = fakeFile('ok.xlsx', XLSX);
    sb.handlePaste(makePasteEvent(clipboardData({
        items: [makeItem('file', XLSX, null), makeItem('file', XLSX, good)], files: [good],
    })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1, '仅有效文件入队，null 项不得占名额');
    // 同上：文件名已被重写，只验后缀与类型
    assert.match(sb.__pendingFiles[0].name, /\.xlsx$/);
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'file');
});

test('非图片但 MIME 含 "image" 字样的类型（如 application/x-image）必须走 file 路径', async () => {
    // 分流口径与拖放路径 handleDrop 保持一致：只有 type 以 'image/' 开头才算图片。
    // 若放宽为 indexOf('image') !== -1，application/x-image 会被归入 images 桶、
    // 以 attachmentsType='image' 发送 → 被当作多模态图片塞给模型，而它根本不是图。
    // 注：attachmentsType 才是发送语义（多模态图 vs 普通文件）；
    //     而 item.type 由 processSelectedFile 内既有的宽松匹配决定（对 MIME 含
    //     image 的文件也生成缩略图预览，故 type='image'），属展示层行为，不在本用例约束内。
    const sb = makeSandbox();
    const f = fakeFile('archive.ximage', 'application/x-image');
    sb.handlePaste(makePasteEvent(clipboardData({ items: [makeItem('file', 'application/x-image', f)], files: [f] })));
    await tick();
    assert.strictEqual(sb.__pendingFiles.length, 1);
    assert.strictEqual(sb.__pendingFiles[0].attachmentsType, 'file',
        'application/x-image 不得被当成多模态图片发送（attachmentsType 应为 file）');
    assert.match(sb.__pendingFiles[0].name, /^pasted-file-/,
        '应走 file 桶的 pasted-file 命名，而非 pasted-image');
});

test('preventDefault 只在确定接管后调用一次（全函数唯一）', () => {
    const body = sliceFunction(SRC, 'function handlePaste(');
    const n = (body.match(/preventDefault\(\)/g) || []).length;
    assert.strictEqual(n, 1, `handlePaste 内 preventDefault 应只出现 1 次，实际 ${n}`);
    // 且必须位于两个早退 return 之后
    const pdIdx = body.indexOf('preventDefault()');
    const firstReturn = body.indexOf('&& !htmlData) return');
    assert.ok(firstReturn > 0 && firstReturn < pdIdx, 'preventDefault 必须在纯文本早退之后');
});
