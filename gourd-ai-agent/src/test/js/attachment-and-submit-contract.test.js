/**
 * 输入框附件入口与统一提交链路的源码契约测试。
 *
 * 该仓库前端为无构建的原生 JS，既有测试风格即「读源码 + 正则断言」（见 file-changes-ui.test.js），
 * 这里沿用同一模式，锁住几个曾经出过事故、且极易在后续改动中被悄悄破坏的约束。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STATIC_JS = path.resolve(__dirname, '../../main/resources/static/js');

function readJs(name) {
    return fs.readFileSync(path.join(STATIC_JS, name), 'utf8');
}

function sliceFunction(source, signature) {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `未找到函数：${signature}`);
    // 从函数签名处向后做花括号配对，取出完整函数体
    let i = source.indexOf('{', start);
    assert.ok(i >= 0, `函数 ${signature} 缺少函数体`);
    let depth = 0;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    return source.slice(start, i + 1);
}

test('handlePaste 必须收齐全部图片，不得在首图后早退', () => {
    const body = sliceFunction(readJs('app-ui.js'), 'function handlePaste(');

    // 旧实现命中第一张图后直接 return，导致多图只进一张
    assert.ok(/images\.push\(/.test(body), 'handlePaste 应把图片收集进数组后批量处理');
    assert.ok(/processSelectedFiles\(images, 'image'/.test(body),
        'handlePaste 应复用批量入口 processSelectedFiles');

    // preventDefault 只能有一处：旧实现在图片分支与 HTML 分支各调一次，
    // 且图片分支提前 return 跳过文本分支，造成「图文混合粘贴时文字被吞」
    const pdCount = (body.match(/preventDefault\(\)/g) || []).length;
    assert.strictEqual(pdCount, 1,
        `handlePaste 内 preventDefault 应只出现 1 次，实际 ${pdCount} 次`);
});

test('handlePaste 必须在处理图片前先落地纯文本', () => {
    const body = sliceFunction(readJs('app-ui.js'), 'function handlePaste(');
    const textIdx = body.indexOf('insertTextAtCursor(');
    const imgIdx = body.indexOf('processSelectedFiles(');
    assert.ok(textIdx > 0, 'handlePaste 应调用 insertTextAtCursor 插入文本');
    assert.ok(imgIdx > 0, 'handlePaste 应调用 processSelectedFiles 处理图片');
    assert.ok(textIdx < imgIdx, '文字必须先于图片落地，避免图文混合粘贴时文字丢失');
});

test('纯文本粘贴仍交还浏览器原生行为（保住 undo 栈与 IME）', () => {
    const body = sliceFunction(readJs('app-ui.js'), 'function handlePaste(');
    assert.ok(/images\.length === 0 && !htmlData[\s\S]{0,40}return/.test(body),
        '无图且无 text/html 时应直接 return，不接管粘贴');
});

test('processSelectedFiles 必须用本地计数器控名额（图片 push 是异步的）', () => {
    const body = sliceFunction(readJs('app-ui.js'), 'function processSelectedFiles(');
    assert.ok(/MAX_ATTACHMENTS - pendingFiles\.length/.test(body),
        '应先算出剩余名额 room');
    assert.ok(/taken\s*>=\s*room/.test(body),
        '应以本地 taken 计数判断名额；只看 pendingFiles.length 会因 FileReader 异步 push 而失效');
    assert.ok(/return taken/.test(body),
        '应返回实际受理数，供调用方判断是否提示「部分未添加」');
});

test('拖放路径同样不得依赖 pendingFiles.length 控名额', () => {
    const body = sliceFunction(readJs('app-ui.js'), 'function handleDrop(');
    assert.ok(/taken\s*>=\s*room/.test(body),
        'handleDrop 的循环名额判断应使用本地计数器，与 processSelectedFiles 同构');
});

test('getImageExtension 死函数已移除', () => {
    const source = readJs('app-ui.js');
    assert.ok(!/function getImageExtension\(/.test(source),
        'getImageExtension 已无调用点，应删除以免与 getFileExtension 混淆');
});

test('三条提交路径必须统一走 postChatInput', () => {
    const streaming = readJs('app-streaming.js');
    const message = readJs('app-message.js');

    assert.ok(/function postChatInput\(/.test(streaming),
        'app-streaming.js 应定义统一提交入口 postChatInput');

    // 正常发送
    const send = sliceFunction(streaming, 'function sendWithFormDataGrouped(');
    assert.ok(/postChatInput\(/.test(send), 'sendWithFormDataGrouped 应走 postChatInput');
    assert.ok(!/new FormData\(\)/.test(send),
        'sendWithFormDataGrouped 不应再自行组装 FormData');

    // 问答卡
    const question = sliceFunction(message, 'function handleQuestionResponse(');
    assert.ok(/postChatInput\(/.test(question), 'handleQuestionResponse 应走 postChatInput');
    assert.ok(!/fetch\(SSE_ENDPOINT/.test(question),
        'handleQuestionResponse 不应再直接 fetch');

    // HITL
    const hitl = sliceFunction(message, 'function handleHitlResponse(');
    assert.ok(/postChatInput\(/.test(hitl), 'handleHitlResponse 应走 postChatInput');
    assert.ok(!/fetch\(SSE_ENDPOINT/.test(hitl),
        'handleHitlResponse 不应再直接 fetch');
});

test('postChatInput 统一携带 model 且按键存在性组装字段', () => {
    const body = sliceFunction(readJs('app-streaming.js'), 'function postChatInput(');

    assert.ok(/getSelectedModel\(\)/.test(body),
        'postChatInput 应统一取当前选中模型，避免某条路径漏传后静默回落默认模型');
    assert.ok(/formData\.append\('model', model\)/.test(body),
        'model 应被 append 到 FormData');
    assert.ok(/hasOwnProperty\.call\(fields, k\)/.test(body),
        '路径独有字段必须按键存在性 append');

    // 绝不能给缺失的 input 补空串：后端靠 input 键存在性区分新一轮/续轮
    assert.ok(!/append\('input',\s*[^)]*\|\|\s*''/.test(body),
        '不得对缺失的 input 键补空串，否则续轮会被误判为新一轮');
});

test('续轮路径不得携带 input 键', () => {
    const message = readJs('app-message.js');
    const question = sliceFunction(message, 'function handleQuestionResponse(');
    const hitl = sliceFunction(message, 'function handleHitlResponse(');

    assert.ok(!/input\s*:/.test(question),
        'handleQuestionResponse 传给 postChatInput 的 fields 不应含 input 键');
    assert.ok(!/input\s*:/.test(hitl),
        'handleHitlResponse 传给 postChatInput 的 fields 不应含 input 键');
});
