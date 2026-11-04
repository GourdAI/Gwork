/**
 * 契约测试：插话（steer）的回放/实时双链路 + 会话态清理 + 后端 meta 端点鲁棒性。
 *
 * 覆盖（对应本批修复 F1/F5/F6/后端）：
 * - app-history.js replayChunk：steer_applied 走【专用分支】直接循环调 appendSteerNote，
 *   绕过 sess.steerResolved、不经 onWebChunk，且分支位于通用 isStreaming/onWebChunk 路径之前
 * - app-streaming.js onWebChunk 的 switch 区块内不得出现 steer_applied（防双重处理回归）；
 *   done 帧收尾必须把 sess.steerResolved 置空
 * - app-message.js appendSteerNote：函数体可执行代码不得再出现 advanceBodyPointer；
 *   purgeEmptyMdBlocks 必须早于 ensureAssistantBubble
 * - app-base.js evictInactiveSessions：LRU 淘汰必须清 steerResolved / steerPending
 * - 后端 WebGate.attachmentMeta：路径 sanitize（NUL/点开头/Windows 保留名）、isRegularFile、
 *   单条 try-catch(RuntimeException|IOException) → error:invalid 且条目必带 path、
 *   META_IMAGE_MAX_BYTES=8MB 流式 readNBytes(MAX+1) → too_large、
 *   META_DATAURL_BUDGET_BYTES=24MB 超预算 → error:budget 且不读文件、extOfName 小写、
 *   missing 分支 LOG.warn
 * - 后端 WebController.attachmentMeta：paramValues("paths") + ATTACHMENT_META_MAX_PATHS
 *   + 超限 400 TOO_MANY_PATHS + resolveSessionRoot 校验 + resolveDir + uploads 目录级回探
 * - SessionStreamStore.recordUser：空附件清单归一为 null（与旧帧逐字节一致）
 * - app-message.js fetchAttachmentMeta：traditional:true 重复键传参、批量常量、
 *   缓存/在途合并、失败不缓存、返回同序数组
 * - 12 个语言包：JSON 可解析、键集合完全一致、插话主题键齐备
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (name) => fs.readFileSync(path.join(javaRoot, name), 'utf8');

const messageJs = readStatic('js', 'app-message.js');
const historyJs = readStatic('js', 'app-history.js');
const streamingJs = readStatic('js', 'app-streaming.js');
const baseJs = readStatic('js', 'app-base.js');
const webGate = readJava('WebGate.java');
const webController = readJava('WebController.java');
const streamStore = readJava('SessionStreamStore.java');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

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

/* 剥掉注释：产品代码的注释里大量正引用被废弃的写法（解释为什么不能这么写），
   直接对原文断言会把这些说明当成违规。 */
function codeOnly(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/* 抽取 switch (chunk.type) { ... } 区块（花括号配平） */
function switchBlock(source, fnName) {
    const body = fnBody(source, fnName);
    const start = body.indexOf('switch (chunk.type)');
    assert.ok(start >= 0, fnName + ' 内未找到 switch (chunk.type)');
    let depth = 0, seen = false;
    for (let i = start; i < body.length; i++) {
        const ch = body[i];
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') { depth--; if (seen && depth === 0) return body.slice(start, i + 1); }
    }
    assert.fail('switch 区块未配平: ' + fnName);
}

/* Java 方法体抽取：必须按【声明】定位（可选修饰符 + 返回类型 + 方法名 + 参数表 + 左花括号），
   不能只搜方法名——调用点（如 `String ext = extOfName(name);`）往往出现在定义之前，
   只搜名字会把调用点后面的代码块当成方法体。修饰符可为空（package-private 方法
   如 WebGate.attachmentMeta 就没有 public/static）。 */
function javaBody(source, name) {
    const re = new RegExp('(?:^|\\n)[ \\t]*'
        + '(?:(?:(?:public|private|protected|static|final|synchronized|abstract)\\s+)*)'
        + '[\\w<>,\\[\\]\\.\\?\\s]+?\\b' + name + '\\s*\\([^;{]*\\)\\s*(?:throws [\\w,\\.\\s]+)?\\{', 'm');
    const m = re.exec(source);
    assert.ok(m, '未找到 Java 方法声明: ' + name);
    let i = m.index + m[0].length;
    let depth = 1;
    for (let j = i; j < source.length; j++) {
        const ch = source[j];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return source.slice(m.index, j + 1); }
    }
    assert.fail('Java 方法体未配平: ' + name);
}

/* ===== ① 回放专用分支 ===== */

test('app-history.js replayChunk：steer_applied 专用分支就地还原，且位于通用 onWebChunk 路径之前', () => {
    const replay = fnBody(historyJs, 'replayChunk');
    const iBranch = replay.indexOf("if (chunk.type === 'steer_applied') {");
    assert.ok(iBranch >= 0, 'replayChunk 必须有 steer_applied 专用分支');
    assert.ok(replay.indexOf('appendSteerNote(sess, sItems[sk])') > iBranch,
        '专用分支内必须直接循环调 appendSteerNote');

    // 专用分支必须自包含 continue，不得落到通用路径
    const branchEnd = replay.indexOf('continue;', iBranch);
    assert.ok(branchEnd > iBranch, '专用分支必须以 continue 结束（不得再进通用路径）');
    const branch = replay.slice(iBranch, branchEnd);
    assert.ok(codeOnly(branch).indexOf('onWebChunk') < 0, '专用分支不得调用 onWebChunk');
    assert.ok(codeOnly(branch).indexOf('steerResolved') < 0,
        '回放不得查/写 steerResolved：该集合可能残留旧键，会把本该渲染的插话吞掉');

    /* 顺序：专用分支必须在通用 isStreaming/onWebChunk 路径之前。
       位置颠倒时 steer_applied 会先被通用路径消费（onWebChunk 用帧上的 phase/runId
       覆写会话状态），插话渲染与本轮流式语义都会被污染。
       定位方式：通用路径就是「置 isStreaming=true 后紧接着调 onWebChunk」的那一段。 */
    const generic = replay.match(/sess\.isStreaming = true;\s*\n\s*onWebChunk\(sess, chunk\);/);
    assert.ok(generic, '未找到通用 isStreaming/onWebChunk 路径');
    const iGeneric = replay.indexOf(generic[0]);
    assert.ok(iBranch < iGeneric, 'steer_applied 专用分支必须位于通用路径之前');

    // file_changes 分支同样在前（专用分支插在它之后、通用路径之前）
    const iFileChanges = replay.indexOf("if (chunk.type === 'file_changes') {");
    assert.ok(iFileChanges >= 0 && iFileChanges < iBranch, 'steer 分支应位于 file_changes 分支之后');
});

test('app-history.js replayDoneCore：插话折叠补测接线（removeAttribute + steerCollapseRemeasure）', () => {
    /* F4 后半段：回放期节点在游离临时容器里测不到高度，只能按阈值初判并打
       data-steer-collapse-pending。fragment 移入真实容器后必须逐行 removeAttribute + 复测，
       否则（a）标记残留，下次回放/切会话又被当成待补测；（b）不复测则初判的折叠态永远不校正。 */
    const core = fnBody(historyJs, 'replayDoneCore');
    assert.match(core, /typeof steerCollapseRemeasure === 'function'/,
        '补测必须带 typeof 守卫（老版本/降级环境无此函数时不得报错）');
    assert.match(core, /\$\(realContainer\)\.find\('\.steer-note\[data-steer-collapse-pending\]'\)/,
        '必须按标记选出待补测的插话行');
    const iFind = core.indexOf("find('.steer-note[data-steer-collapse-pending]')");
    const iRemove = core.indexOf("removeAttribute('data-steer-collapse-pending')");
    const iRemeasure = core.indexOf('steerCollapseRemeasure(pendingSteerRow)');
    assert.ok(iFind >= 0 && iRemove > iFind, '必须逐行 removeAttribute 补测标记');
    assert.ok(iRemove >= 0 && iRemeasure > iRemove,
        'removeAttribute 必须先于复测：先复测会把标记行当普通行处理');
    assert.ok(core.indexOf('catch (steerErr)') > iFind,
        '单行补测必须包 try-catch，一行量高失败不得中断整页收尾');
    /* 补测必须在 fragment 已移入真实容器之后：游离节点 getComputedStyle/scrollHeight 恒为 0，
       先补测等于没测（这正是回放期只能打 pending 标记、入真实容器再补测的原因）。 */
    const iMove = core.indexOf('realContainer.appendChild(fragment);');
    assert.ok(iMove >= 0 && iRemeasure > iMove,
        '补测必须晚于 fragment 移入真实容器（否则测不到高度）');
    assert.ok(core.indexOf('sess.renderTarget = null;') < iMove,
        '移入真实容器前必须先还原渲染落点');
});

/* ===== ② 实时链路不双重处理 ===== */

test('app-streaming.js onWebChunk：switch 区块内不得出现 steer_applied（防双重处理）', () => {
    const block = codeOnly(switchBlock(streamingJs, 'onWebChunk'));
    assert.ok(block.indexOf('steer_applied') < 0,
        'steer 帧由 dispatchGateChunk 前置分支消费；onWebChunk 再处理一次会重复建卡/污染相位');
    // 反向确认：实时链路的处理点仍在 dispatchGateChunk（否则等于把功能整个删了）
    const dispatch = fnBody(streamingJs, 'dispatchGateChunk');
    assert.match(dispatch, /chunk\.type === 'steer_applied' \|\| chunk\.type === 'steer_dropped' \|\| chunk\.type === 'steer_cancelled'/,
        'dispatchGateChunk 必须保留插话协议帧的前置分支');
    const iSteer = dispatch.indexOf("if (chunk.type === 'steer_applied'");
    const iAuto = dispatch.indexOf('var sess2 = getOrCreateSession(sid);');
    assert.ok(iSteer >= 0 && iAuto > iSteer, '插话分支必须在「自动进入 streaming 态」之前处理');
    assert.match(dispatch, /steerSess\.steerResolved\[item\.steerId\] = chunk\.type;/, '实时链路必须登记幂等键');
    assert.match(dispatch, /appendSteerNote\(steerSess, item\);/, '实时链路仍必须渲染插话气泡');
});

/* ===== ③ 轮次边界 ===== */

test('appendSteerNote：可执行代码不含 advanceBodyPointer，且 purge 早于 ensure', () => {
    const body = fnBody(messageJs, 'appendSteerNote');
    const code = codeOnly(body);
    assert.ok(code.indexOf('advanceBodyPointer') < 0,
        '轮次边界不得再走正文指针推进（旧实现会让新正文块成孤儿或插到插话上方）');
    assert.ok(code.indexOf('insertBeforeActions') < 0, '同理不得再调 insertBeforeActions');
    // 注释里仍应保留「为什么不能用」的说明，防止后人再改回去
    assert.ok(body.indexOf('advanceBodyPointer') >= 0, '函数注释应保留 advanceBodyPointer 的禁用理由');

    const iFinish = code.indexOf('_streamMd.finish()');
    const iClear = code.indexOf('sess.currentBubbleEl = null;');
    const iPurge = code.indexOf('purgeEmptyMdBlocks(renderRoot(sess));');
    const iFlag = code.indexOf('sess._thinkingInterruptedByAction = true;');
    const iEnsure = code.indexOf('ensureAssistantBubble(sess);');
    assert.ok(iFinish >= 0 && iClear > iFinish, '必须先收尾旧气泡的流式渲染器再清指针');
    assert.ok(iClear >= 0 && iPurge > iClear, '清指针必须先于空壳清扫');
    assert.ok(iPurge >= 0 && iFlag > iPurge, '清扫后才标记思考被打断');
    assert.ok(iFlag >= 0 && iEnsure > iFlag, 'ensureAssistantBubble 必须是轮次边界最后一步');
    assert.ok(iPurge < iEnsure, 'purgeEmptyMdBlocks 必须早于 ensureAssistantBubble');
});

/* ===== ④ 会话态清理 ===== */

test('app-base.js evictInactiveSessions：LRU 淘汰必须清 steerResolved / steerPending', () => {
    const evict = fnBody(baseJs, 'evictInactiveSessions');
    assert.match(evict, /sess\.steerResolved = \{\};/,
        '容器已 empty() 而幂等键仍在 → 重新进入会话时回放还原的同一插话被当成已处理而静默丢弃');
    assert.match(evict, /sess\.steerPending = \{\};/,
        '待受理项已随 DOM 消失，留着只会让迟到的 HTTP 回调改写幽灵状态');
    // 清理必须在容器清空之后（顺序颠倒等于没清）
    assert.ok(evict.indexOf('$(sess.container).empty();') < evict.indexOf('sess.steerResolved = {};'),
        'steer 登记表清理必须发生在容器清空之后');
    // 会话构造函数里两张表必须成对初始化
    assert.match(baseJs, /this\.steerPending = \{\};/, 'SessionState 必须初始化 steerPending');
    assert.match(baseJs, /this\.steerResolved = \{\};/, 'SessionState 必须初始化 steerResolved');
});

test('app-streaming.js done 帧收尾必须把 steerResolved 置空', () => {
    const dispatch = fnBody(streamingJs, 'dispatchGateChunk');
    const iDone = dispatch.indexOf("if (chunk.type === 'done') {");
    const iFiler = dispatch.indexOf("if (chunk.type === 'filer_change') {");
    assert.ok(iDone >= 0 && iFiler > iDone, '未定位到 done 帧分支');
    const doneBranch = dispatch.slice(iDone, iFiler);
    assert.match(doneBranch, /sess\.steerResolved = \{\};/,
        '插话幂等集合只服务实时竞态，轮结束即过期；不清会让下一轮/淘汰重建后的回放被误拦');
    // 必须在 finishStream 之前置空（收尾里可能触发新一轮渲染）
    assert.ok(doneBranch.indexOf('sess.steerResolved = {};') < doneBranch.indexOf('finishStream(sess'),
        'steerResolved 置空必须早于 finishStream');
    assert.match(doneBranch, /sess\.activeRunId = null;/, 'done 分支仍需清 activeRunId');
});

/* ===== ⑤ 前端 meta 拉取契约 ===== */

test('fetchAttachmentMeta：traditional 重复键传参 + 批量常量 + 缓存/在途合并 + 失败不缓存', () => {
    const fetchFn = fnBody(messageJs, 'fetchAttachmentMeta');
    assert.match(fetchFn, /traditional: true/, '必须用 jQuery traditional 以重复键传 paths');
    assert.ok(fetchFn.indexOf("paths.join(',')") < 0, '不得再手工逗号拼接（多图会撞 URL 长度上限）');
    assert.match(messageJs, /var ATTACH_META_BATCH_SIZE = 12;/, '批量上限常量必须是 12');
    assert.match(fetchFn, /b \+= ATTACH_META_BATCH_SIZE/, '必须按批量常量分批');
    assert.match(messageJs, /var attachMetaCache = \{\};/, '必须有模块级结果缓存');
    assert.match(messageJs, /var attachMetaInflight = \{\};/, '必须有模块级在途合并表');
    assert.match(messageJs, /function attachMetaKey\(sid, path\) \{\s*\n\s*return sid \+ '\\u0001' \+ path;/,
        '缓存键必须是 sid + \\u0001 + path（避免跨会话串图）');
    assert.match(fetchFn, /attachMetaInflight\[key\]/, '同 key 在途请求必须复用');
    assert.match(fetchFn, /if \(got && !got\.error\) attachMetaCache\[group\[n\]\.key\] = got;/,
        '带 error 的条目不得写缓存（否则失败结果被永久钉住）');
    assert.match(fetchFn, /results\[k\] = null/, '空路径必须占位为 null');
    assert.match(fetchFn, /var results = new Array\(total\);/, '返回值必须与入参同长同序');
    assert.match(fetchFn, /typeof sessOrId === 'object'/, '必须兼容会话对象与 sessionId 字符串两种入参');
    assert.match(fetchFn, /rootFor\(sessOrId\)/, '会话对象入参时 root 走 rootFor（与回放/删除同口径）');
    assert.match(fetchFn, /getSessionCwd\(\)/, '字符串入参时 root 走 getSessionCwd');
    assert.match(fetchFn, /url: '\/web\/chat\/attachment\/meta'/, '端点不得手工拼 query');
    assert.match(fetchFn, /data: \{ sessionId: sid, root: root \|\| '', paths: batchPaths \}/, '参数走 data 交由 jQuery 序列化');
    // 整批失败必须兜底为全 null（调用方降级），不得抛异常打断渲染
    assert.match(fetchFn, /for \(var n = 0; n < group\.length; n\+\+\) out\.push\(null\);/,
        '整批失败必须兜底为全 null 数组');
});

/* ===== ⑥ 后端 WebGate.attachmentMeta 鲁棒性 ===== */

test('WebGate.attachmentMeta：单条隔离 + path 必带 + 大小/预算双上限 + 流式读', () => {
    const meta = javaBody(webGate, 'attachmentMeta');

    assert.match(meta, /row\.put\("path", raw\);/, '条目必须带 path 字段（前端按 item.path 回填）');
    assert.ok(meta.indexOf('row.put("path", raw);') < meta.indexOf('try {'),
        'path 必须在 try 之前写入：任何一步抛出，条目也能被前端正确归位');
    assert.match(meta, /sanitizeAttachmentPath\(raw\)/, '非法路径必须走 sanitize 校验');
    assert.match(meta, /row\.put\("error", "invalid"\);\s*\n\s*continue;/, 'sanitize 不过 → error:invalid 且不整批失败');
    assert.match(meta, /!file\.startsWith\(uploadsRoot\)/, '越界路径必须拒绝');
    assert.match(meta, /java\.nio\.file\.Files\.isRegularFile\(file\)/,
        '必须用 isRegularFile 而非 exists（目录/设备/失效链接都归为 missing）');
    assert.match(meta, /row\.put\("error", "missing"\)/, '缺失文件以 error 条目返回');
    assert.match(meta, /LOG\.warn\("\[WebGate\] attachment meta missing/, 'missing 分支必须留日志');
    assert.match(meta, /catch \(RuntimeException \| java\.io\.IOException e\) \{\s*\n[\s\S]*?row\.put\("error", "invalid"\);/,
        '单条 try-catch(RuntimeException|IOException) → error:invalid，畸形 path 不得让整批 500');
    assert.match(webGate, /private static final long META_IMAGE_MAX_BYTES = 8L \* 1024 \* 1024;/, '单张上限 8MB');
    assert.match(webGate, /private static final long META_DATAURL_BUDGET_BYTES = 24L \* 1024 \* 1024;/, '响应体预算 24MB');
    assert.match(meta, /in\.readNBytes\(\(int\) Math\.min\(META_IMAGE_MAX_BYTES \+ 1, Integer\.MAX_VALUE\)\)/,
        '必须带上限流式读 readNBytes(MAX+1)：不把超限文件读进内存，又能确实判出超限');
    assert.match(meta, /if \(bytes\.length > META_IMAGE_MAX_BYTES\) \{\s*\n\s*row\.put\("error", "too_large"\);/,
        '读回字节超限 → too_large');
    assert.match(meta, /if \(size < 0 \|\| size > META_IMAGE_MAX_BYTES\) \{\s*\n\s*row\.put\("error", "too_large"\);/,
        'size 读不到（-1）时 fail-closed 归为 too_large');
    assert.match(meta, /if \(dataUrlBytes \+ estimated > META_DATAURL_BUDGET_BYTES\) \{\s*\n[\s\S]{0,200}?row\.put\("error", "budget"\);\s*\n\s*continue;/,
        '超预算 → error:budget');
    assert.ok(meta.indexOf('META_DATAURL_BUDGET_BYTES') < meta.indexOf('Files.newInputStream'),
        '预算判定必须在读文件之前（超预算不读文件也不编码）');
    assert.match(meta, /"data:" \+ extensionToMime\(ext\) \+ ";base64,"/, 'dataUrl 口径与注入链路一致');
});

test('WebGate.sanitizeAttachmentPath：拒 NUL / 点开头 / Windows 保留名；extOfName 小写', () => {
    const sanitize = javaBody(webGate, 'sanitizeAttachmentPath');
    assert.match(sanitize, /p\.indexOf\('\\0'\) >= 0/, '必须拒绝含 NUL 的路径');
    assert.match(sanitize, /if \(!p\.startsWith\(prefix\)\) return null;/, '必须以 uploads/ 前缀开头');
    assert.match(sanitize, /name\.contains\("\.\."\)/, '必须拒绝 ..');
    assert.match(sanitize, /if \(name\.startsWith\("\."\)\) return null;/, '点开头（含隐藏名）一律拒绝');
    assert.match(sanitize, /if \(isWindowsReservedName\(name\)\) return null;/, 'Windows 保留设备名必须拒绝');
    assert.match(webGate, /private static final Set<String> WINDOWS_RESERVED_NAMES/, '必须有 Windows 保留名单常量');
    const reserved = javaBody(webGate, 'isWindowsReservedName');
    for (const n of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']) {
        assert.ok(webGate.indexOf('"' + n + '"') >= 0, '保留名单必须含 ' + n);
    }
    assert.match(reserved, /base\.toUpperCase\(Locale\.ROOT\)/, '保留名判定必须忽略大小写');
    assert.match(reserved, /base\.endsWith\("\."\) \|\| base\.endsWith\(" "\)/, '尾随点/空格必须剥掉（"CON." 仍是 CON）');
    assert.match(javaBody(webGate, 'extOf'), /\.toLowerCase\(Locale\.ROOT\)/, 'extOf 同样必须小写归一');
    const extOfName = javaBody(webGate, 'extOfName');
    assert.match(extOfName, /return name\.substring\(dot\)\.toLowerCase\(Locale\.ROOT\);/,
        'extOfName 必须返回小写的 .ext（.PNG 与 .png 同口径，否则大图被判成普通文件）');
    assert.match(extOfName, /int dot = name\.lastIndexOf\('\.'\);/, '必须按最后一个点号切扩展名');
    assert.match(extOfName, /if \(dot < 0 \|\| dot == name\.length\(\) - 1\) return "";/, '无扩展名/尾点必须回空串');
});

/* ===== ⑦ 后端 WebController.attachmentMeta ===== */

test('WebController.attachmentMeta：paramValues 取全量 + 批量上限 400 + 根校验 + uploads 目录级回探', () => {
    const ctrl = javaBody(webController, 'attachmentMeta');
    assert.match(ctrl, /ctx\.paramValues\("paths"\)/,
        'paths 是重复表单键，必须用 paramValues 取全量（@Param 单值绑定会静默丢附件）');
    assert.match(webController, /private static final int ATTACHMENT_META_MAX_PATHS = 32;/, '必须有批量上限常量');
    assert.match(ctrl, /if \(wanted\.size\(\) > ATTACHMENT_META_MAX_PATHS\) \{\s*\n\s*return Result\.failure\(400, "TOO_MANY_PATHS"\);/,
        '超限必须 400 TOO_MANY_PATHS（明确契约优于静默截断）');
    assert.match(ctrl, /validateSessionId\(sessionId\)/, '必须校验 sessionId 形态');
    assert.match(ctrl, /String sessionRoot = resolveSessionRoot\(sessionId, root\);/, '必须走 resolveSessionRoot 校验工作空间根');
    assert.match(ctrl, /if \(sessionRoot == null && Assert\.isNotEmpty\(root\)\) \{\s*\n\s*return Result\.failure\(400/,
        '请求根与会话登记根不一致必须明确拒绝');
    assert.match(ctrl, /sessionLocator\.resolveDir\(sessionId, sessionRoot\)/, '必须用 resolveDir 解析会话目录');
    assert.match(ctrl, /if \(!new File\(sessionDir, "uploads"\)\.isDirectory\(\)\) \{/, 'primary 无 uploads 时必须回探');
    assert.match(ctrl, /sessionLocator\.allKnownSessionDirs\(sessionId, sessionRoot\)/, '回探范围必须是全部已知落点');
    assert.match(ctrl, /webGate\.attachmentMeta\(sessionDir, wanted\)/, '读盘必须委派给 WebGate');
    assert.match(webController, /@Mapping\("\/web\/chat\/attachment\/meta"\)/, '端点映射不得改名');
});

/* ===== ⑧ 后端落盘：空清单归一 null ===== */

test('SessionStreamStore.recordUser：七参重载 + 空附件清单归一为 null', () => {
    assert.match(streamStore, /public void recordUser\(String sessionId, String projectRoot, String text, long createdAt,\s*\n\s*String clientMessageId, List<String> imagePaths, List<String> filePaths\)/,
        '必须有携带附件路径的七参重载');
    assert.match(streamStore, /uc\.setImagePaths\(imagePaths == null \|\| imagePaths\.isEmpty\(\) \? null : imagePaths\);/,
        '空图片清单必须归一为 null（序列化器会把空 List 写成 "imagePaths":[]，与旧帧不一致）');
    assert.match(streamStore, /uc\.setFilePaths\(filePaths == null \|\| filePaths\.isEmpty\(\) \? null : filePaths\);/,
        '空文件清单同理归一为 null');
    assert.match(streamStore, /isEmpty\(\) \? null/, '归一写法必须存在');
    // 少参重载必须把附件位补成 null，而不是空集合
    assert.match(streamStore, /recordUser\(sessionId, projectRoot, text, createdAt, null, null, null\);/,
        '四参重载必须委派七参并传 null');
    assert.match(streamStore, /recordUser\(sessionId, projectRoot, text, createdAt, clientMessageId, null, null\);/,
        '五参重载必须委派七参并传 null');
});

/* ===== ⑨ 语言包 ===== */

function flattenKeys(obj, prefix, out) {
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        const nk = prefix ? prefix + '.' + k : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flattenKeys(v, nk, out);
        else out.push(nk);
    }
    return out;
}

test('12 个语言包：JSON 可解析、键集合完全一致、插话主题键齐备', () => {
    const parsed = {};
    for (const lang of LOCALES) {
        const file = path.join(staticRoot, 'locales', lang + '.json');
        assert.ok(fs.existsSync(file), '缺少语言包文件: ' + lang + '.json');
        const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            assert.fail(lang + '.json 不是合法 JSON: ' + e.message);
        }
        assert.equal(typeof data, 'object');
        parsed[lang] = flattenKeys(data, '', []).sort();
    }
    const ref = parsed.en;
    assert.ok(ref.length > 100, 'en.json 键数量异常（' + ref.length + '），疑似解析口径错了');
    for (const lang of LOCALES) {
        const cur = parsed[lang];
        const missing = ref.filter(k => cur.indexOf(k) < 0);
        const extra = cur.filter(k => ref.indexOf(k) < 0);
        assert.deepEqual(missing, [], lang + '.json 相对 en.json 缺少键: ' + missing.slice(0, 10).join(', '));
        assert.deepEqual(extra, [], lang + '.json 相对 en.json 多出键: ' + extra.slice(0, 10).join(', '));
    }
    // 本主题键必须齐全且非空
    for (const lang of LOCALES) {
        const data = JSON.parse(fs.readFileSync(path.join(staticRoot, 'locales', lang + '.json'), 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(data.streaming, lang + ' 缺少 streaming 段');
        for (const key of ['steer_tag', 'steer_expand_full', 'steer_collapse']) {
            const v = data.streaming[key];
            assert.ok(typeof v === 'string' && v.trim().length > 0, lang + ' streaming.' + key + ' 缺失或为空');
        }
        assert.ok(data.streaming.steer_expand_full.indexOf('{0}') >= 0,
            lang + ' steer_expand_full 必须保留 {0} 字数占位符');
        // 队列徽标键（附件降级链路文案）同样必须存在
        assert.ok(data.queue && typeof data.queue.images === 'string' && data.queue.images.length > 0,
            lang + ' queue.images 缺失（附件降级徽标文案）');
    }
    // 键集合一致性也覆盖到「语言包数量」本身：目录里不得混进未登记的语言
    const files = fs.readdirSync(path.join(staticRoot, 'locales'))
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -'.json'.length))
        .sort();
    assert.deepEqual(files, LOCALES.slice().sort(),
        'locales 目录的语言文件清单必须与测试登记的 12 种语言一致');
});
