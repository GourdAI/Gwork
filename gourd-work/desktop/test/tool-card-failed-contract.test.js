/**
 * 契约护栏：工具卡成败判定唯一依赖后端结构化 `failed` 布尔标识（禁止文本嗅探）。
 *
 * ── 缺陷现场 ────────────────────────────────────────────────────────────────
 * 旧前端靠 `startsWith('__ERROR__')` 之类的结果文本前缀判失败；Rust 内核的成功
 * 文案是英文 `Edited ...`、失败文案也未必带统一前缀，于是失败卡被画成绿点、
 * 成功卡反而被 edit 渲染器按「成功完成」文案嗅探成错误。唯一可靠的真源是
 * `action_end_failed` 写在帧顶层的 `failed: true`，经 app-streaming.js 透传为
 * `chunk.failed === true`，再一路交给 setToolCardStatus / edit 渲染器。
 *
 * ── 测试形态（重要）────────────────────────────────────────────────────────
 * 两份 app-message.js 镜像由另一个任务并行修改，故这里**只做源码正则/字符串
 * 断言**，断言的是期望目标状态；不在 node:vm 里 eval 当前函数体真跑——那会与
 * 并行写入竞态，也会把浏览器全局带进 node:test。花括号配平仅用于切出函数体做
 * 两份镜像的逐字一致性比较（与 stale-agent-frame.test.js 的 extractHelper 同
 * 手法），不执行其中任何一行。
 *
 * 读到的源码统一把 CRLF 归一成 LF：两份镜像当前都是 CRLF，混用行尾不应让
 * 「两份函数体完全相等」这条契约假红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * __dirname = <repo>/gourd-work/desktop/test
 *   ../                     -> gourd-work/desktop
 *   ../../                  -> gourd-work
 *   ../../../               -> <repo>  (gourdai-java 在此层)
 * 前端唯一源是 gourd-work/desktop/ui；Java 侧 static 为入库的历史镜像。
 * 根级 gourd-ai-tauri/ui 是 7370119 已删除、.gitignore 忽略的构建期拷贝残骸，
 * CI checkout 后不存在，绝不作为第三份镜像锁进契约。
 * 两条相对路径均已按仓库实际层级核对。
 */
const MIRRORS = [
    {
        name: 'gourd-work/desktop/ui/js/app-message.js',
        streamName: 'gourd-work/desktop/ui/js/app-streaming.js',
        msg: path.resolve(__dirname, '../ui/js/app-message.js'),
        stream: path.resolve(__dirname, '../ui/js/app-streaming.js')
    },
    {
        name: 'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js',
        streamName: 'gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-streaming.js',
        msg: path.resolve(__dirname, '../../../gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-message.js'),
        stream: path.resolve(__dirname, '../../../gourdai-java/gourd-ai-agent/src/main/resources/static/js/app-streaming.js')
    }
];

const RUST_PROTOCOL = path.resolve(__dirname, '../../core/src/protocol/mod.rs');
const RUST_PROTOCOL_NAME = 'gourd-work/core/src/protocol/mod.rs';

function readSource(file, label) {
    assert.ok(fs.existsSync(file), `${label}：源码文件不存在（${file}）`);
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * 花括号配平抽取：从 anchor 起找第一个 '{'，深度归零处即函数体结束。
 * 与 stale-agent-frame.test.js 的 extractHelper 同手法；此处只做字符串切分，
 * 绝不 eval / runInContext（并行修改竞态 + 浏览器全局依赖）。
 */
function extractBlock(src, anchor, label) {
    const start = src.indexOf(anchor);
    assert.ok(start >= 0, `${label}：找不到定义锚点「${anchor}」`);
    let depth = 0;
    let i = src.indexOf('{', start);
    assert.ok(i >= 0, `${label}：锚点之后没有函数体起始花括号`);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    assert.equal(depth, 0, `${label}：花括号不配平（源码可能被并发写入截断）`);
    return src.slice(start, i + 1);
}

/* ===== 测试 1：判定口径 ===== */

test('测试1 两份镜像都以 failed 为唯一判定，不再有 __ERROR__ / 成功完成 兜底', () => {
    for (const m of MIRRORS) {
        const src = readSource(m.msg, m.name);

        assert.ok(
            src.includes('var isError = failed === true;'),
            `${m.name}：契约「setToolCardStatus 只认 failed === true，状态点不得嗅探文本」被破坏` +
            `（缺少 var isError = failed === true;）`
        );
        assert.ok(
            src.includes('var isErr = failed === true;'),
            `${m.name}：契约「edit 渲染器只认 failed === true，不得嗅探成功文案」被破坏` +
            `（缺少 var isErr = failed === true;）`
        );
        assert.ok(
            !src.includes("startsWith('__ERROR__')"),
            `${m.name}：契约「不再有 __ERROR__ 文本前缀兜底」被破坏（残留 startsWith('__ERROR__')）`
        );
        assert.ok(
            !src.includes('成功完成'),
            `${m.name}：契约「不再按『成功完成』文案猜成败」被破坏（源码仍含「成功完成」）`
        );

        // 口径必须写在 setToolCardStatus 的注释里，防止后来者重新引入文本兜底
        // 却无人察觉。取定义前 400 字符即可覆盖该注释块。
        const statusIdx = src.indexOf('function setToolCardStatus(');
        assert.ok(statusIdx >= 0, `${m.name}：契约「setToolCardStatus 存在」被破坏（定义丢失）`);
        const statusComment = src.slice(Math.max(0, statusIdx - 400), statusIdx);
        assert.ok(
            statusComment.includes('唯一真源'),
            `${m.name}：契约「setToolCardStatus 注释声明 failed 为唯一真源」被破坏（缺少「唯一真源」说明）`
        );
    }
});

/* ===== 测试 2：两份镜像逐字一致 ===== */

test('测试2 两份镜像的 setToolCardStatus 与 edit 渲染器函数体完全相等', () => {
    const anchors = [
        {
            key: 'setToolCardStatus',
            anchor: 'function setToolCardStatus(cardEl, text, failed) {'
        },
        {
            key: 'window._toolRenderers.edit',
            anchor: 'window._toolRenderers.edit = function(bodyEl, text, args, failed) {'
        }
    ];

    for (const a of anchors) {
        const bodies = MIRRORS.map((m) => ({
            name: m.name,
            body: extractBlock(readSource(m.msg, m.name), a.anchor, `${m.name} / ${a.key}`)
        }));
        for (let i = 1; i < bodies.length; i++) {
            assert.ok(
                bodies[i].body === bodies[0].body,
                `${bodies[i].name}：契约「两份镜像 ${a.key} 函数体逐字一致」被破坏` +
                `（与基准 ${bodies[0].name} 不同：${bodies[i].body.length} vs ${bodies[0].body.length} 字符）`
            );
        }
    }
});

/* ===== 测试 3：failed 透传链路 ===== */

test('测试3 failed 已透传到渲染/暂存/更新函数，且 appendActionEndChunk 各收卡分支都带 failed', () => {
    // 三个函数的签名（与调用点）都必须带 failed 形参/实参，任一处漏传都会让
    // 折叠卡首次展开时按 false 渲染成成功，或让 edit 渲染器不显示错误段。
    const signatures = [
        'renderToolBody(bodyEl, toolName, text, args, failed)',
        'setToolBodyPending(cardEl, sess, toolName, text, args, meta, failed)',
        'updateToolCardContent(sess, cardEl, toolName, toolTitle, args, text, meta, options, failed)'
    ];

    for (const m of MIRRORS) {
        const src = readSource(m.msg, m.name);

        for (const sig of signatures) {
            assert.ok(
                src.includes(sig),
                `${m.name}：契约「failed 必须透传到 ${sig.split('(')[0]}」被破坏（找不到 ${sig}）`
            );
        }

        // 只统计 appendActionEndChunk 函数体内
        //   updateToolCardContent(..., toolPresentationOptions(...), failed)
        // 这种「toolPresentationOptions 调用后紧跟 , failed)」的形态。
        // 不直接统计 ", failed);"：它会把 setToolCardStatus(..., failed) 等
        // 一并算进去（约 15 次），口径太宽，漏掉某条收卡分支照样能凑够 5 次。
        // 当前实现恰有 5 条收卡分支，故要求 >= 5。
        const endBody = extractBlock(
            src,
            'function appendActionEndChunk(',
            `${m.name} / appendActionEndChunk`
        );
        const passes = endBody.match(/toolPresentationOptions\([^;]*?\), failed\)/g) || [];
        assert.ok(
            passes.length >= 5,
            `${m.name}：契约「appendActionEndChunk 的每条收卡分支都把 failed 交给 updateToolCardContent」被破坏` +
            `（匹配 ${passes.length} 处，要求 >= 5）`
        );
    }
});

/* ===== 测试 4：流式入口 ===== */

test('测试4 两份 app-streaming.js 都按 chunk.failed === true 透传', () => {
    for (const m of MIRRORS) {
        const src = readSource(m.stream, m.streamName);

        assert.ok(
            src.includes('chunk.failed === true'),
            `${m.streamName}：契约「action_end 帧只认结构化 chunk.failed === true」被破坏`
        );
        assert.ok(
            /appendActionEndChunk\([^;]*?chunk\.failed === true[^;]*?\);/.test(src),
            `${m.streamName}：契约「chunk.failed === true 必须作为 appendActionEndChunk 的实参传入」被破坏` +
            `（只是出现在别处、并未真正透传）`
        );
    }
});

/* ===== 测试 5：Rust 协议层 ===== */

test('测试5 Rust 协议层 action_end_failed 必须写入顶层 failed', () => {
    const src = readSource(RUST_PROTOCOL, RUST_PROTOCOL_NAME);
    const marker = '.extra("failed", serde_json::json!(true))';

    assert.ok(
        src.includes(marker),
        `${RUST_PROTOCOL_NAME}：契约「action_end_failed 落顶层 failed 布尔」被破坏` +
        `（${marker} 被删除或改名）`
    );
    // 必须写在 action_end_failed 内部：Frame.extra 带 #[serde(flatten)]，
    // 只有这一处能让 failed 出现在 JSON 顶层；挪到别的构造函数里等于没写。
    const body = extractBlock(
        src,
        'pub fn action_end_failed(',
        `${RUST_PROTOCOL_NAME} / action_end_failed`
    );
    assert.ok(
        body.includes(marker),
        `${RUST_PROTOCOL_NAME}：契约「failed 由 action_end_failed 独占下发」被破坏` +
        `（action_end_failed 函数体内没有 ${marker}）`
    );
});
