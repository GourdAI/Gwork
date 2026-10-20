/**
 * 契约测试：远程连接向导「连接 + 选目录」一体化（三步流）与目录浏览器新建文件夹。
 *
 * 用户投诉（2026-10-15，四点）：
 *  1) 「远程工作空间在这打开，那我想再连接别的远程工作空间不是不行了嘛」
 *  2) 「只能选择文件夹，无法新增创建自己的文件夹，这肯定有问题的」
 *  3) 「人家（ZCode）是连接、选目录一起的，现在你这样的，每次都得重新连接嘛？」
 *  4) 「打开远程目录的按钮把远程连接的按钮挤下去了，底部有点遮挡」
 *
 * 对标取证：ZCode v3.15.1（源码 + 仓库内设计文档）确为单弹窗四步连续流，
 * 连接成功后【弹窗不关闭】、就地推进 directory 步并内嵌目录树
 * （remoteConnectionDialogState.ts:46-55 的修复注释直言：连接完成后只更新内部步骤
 * 而没有重新展示弹窗，用户会停留在其它页面且看不到选目录或失败原因）。
 * 且 ZCode 远程目录浏览器【同样不能新建文件夹】（IFileService 无 mkdir），
 * 故本项属超越对标而非补齐。
 *
 * 本文件覆盖（行为优先，源码字符串只用于锁「接线」）：
 * - 三步流状态机：wizardCloseReason / wizardFlowActive 真执行（vm 沙箱，非字符串断言）
 * - 连接成功【不关窗】、推进 directory 步（锁 doConnect 成功分支的真实语句）
 * - 收起（minimize）非破坏 vs 关闭（close）需确认，两条通道语义不同
 * - 重开恢复步骤（活跃→当前步；空闲→settings）
 * - 「连接另一台」入口存在且不清既有连接
 * - 已保存主机【一键直连】（不再只回填表单）+ 编辑次级入口
 * - 目录浏览器渲染核：竞态守卫、scope 归属、destroy 幂等（真执行）
 * - 新建文件夹走 /projects/mkdir【而非 create】（create 会顺带登记项目 → 垃圾条目）
 * - app-workspace 登记钩子（一体化向导与「打开远程目录」分支共用，消除副本）
 * - 底部遮挡修复：CSS 双层可压缩（详见 workspace-dropdown-bottom-occlusion.test.js，
 *   此处只锁「三个动作按钮齐备且远程连接在最后」这一与症状对应的顺序不变量）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const remote = readStatic('js', 'app-remote.js');
const code = readStatic('js', 'app-code.js');
const workspace = readStatic('js', 'app-workspace.js');
const webCtrl = fs.readFileSync(path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web/WebController.java'), 'utf8');

/* 剥注释：设计文档里常引用键名/选择器作说明，不剥离会产生假命中（本仓已踩多次） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const remoteCode = stripComments(remote);
const codeCode = stripComments(code);
const workspaceCode = stripComments(workspace);

/* 自检：剥注释后 function 数量必须减少且仍 >0，否则说明剥离失效（历史上字符级
   正则状态机在 JS 上不可靠；此处用行级 + 非贪婪块注释，只做减法故安全） */
test('自检：注释剥离生效（否则「注释里提到过」会被当成「代码里写了」）', () => {
    const countFn = (s) => (s.match(/function\s+\w+\s*\(/g) || []).length;
    assert.ok(countFn(remoteCode) > 20, '剥注释后仍应有大量函数');
    assert.ok(countFn(remoteCode) <= countFn(remote), '剥注释只会减少不会增加');
    // 抽样：我写在注释里的「反例」形态必须被剥掉（否则会被误判为代码）
    assert.ok(!/'remote\.step_' \+/.test(remoteCode), '注释里的动态拼接反例未被剥离（剥离失效）');
    assert.ok(/'remote\.step_settings'/.test(remoteCode), '真实的字面量键引用必须保留');
});

/* ============ 1) 三步流状态机：真执行（vm 沙箱） ============ */

/** 从源码切出顶层/闭包内函数（4 空格缩进，闭合在行首 4 空格的 }）。
    WHY 行尾兼容：本仓主源行尾约定并存（app-remote 纯 LF、app-code/app-workspace 纯 CRLF），
    写死 \n    }\n 会在 CRLF 文件上 search=-1 → 全部「收尾定位失败」假红（实测踩过 9 例）。 */
function cutFn(src, header) {
    const at = src.indexOf(header);
    assert.ok(at >= 0, '函数缺失: ' + header);
    const body = src.slice(at);
    const end = body.search(/\r?\n    \}\r?\n/);
    assert.ok(end > 0, '函数收尾定位失败: ' + header);
    return body.slice(0, end + body.slice(end).match(/^\r?\n    \}/)[0].length);
}

/** 在 vm 里以【闭包内函数】语义执行（这些函数都在 app-remote.js 的 IIFE 内） */
function runRemoteFns(setup, body) {
    const ctx = vm.createContext(Object.assign({
        GourdI18n: { t: (k) => k },
        console,
    }, setup));
    return vm.runInContext('(function(){' + body + '})()', ctx);
}

test('行为・wizardCloseReason：连接中→connecting；已连接未选目录→connected；空闲→null（可直接关）', () => {
    const src = cutFn(remoteCode, 'function wizardCloseReason(step, connId, loading) {');
    const r = runRemoteFns({}, src + '\nreturn { f: wizardCloseReason };');
    assert.equal(r.f('settings', null, true), 'connecting', '正在连接时必须要求确认');
    assert.equal(r.f('connecting', null, true), 'connecting');
    assert.equal(r.f('directory', 'rc-x', false), 'connected', '已连接未选目录：确认「离开已连接会话」');
    assert.equal(r.f('directory', null, false), null, '无连接 id 的 directory 步不需确认');
    assert.equal(r.f('settings', 'rc-x', false), null, 'settings 步即使有残留连接也无需确认（表单态无会话悬空）');
    assert.equal(r.f('settings', null, false), null, '空闲态直接关');
});

test('行为・wizardFlowActive：正在连接 或 已连接未选目录 才算活跃（收起后入口要点亮指示器）', () => {
    const src = cutFn(remoteCode, 'function wizardFlowActive() {');
    const cases = [
        [{ connecting: true, wizardStep: 'settings', wizardConnId: null }, true],
        [{ connecting: true, wizardStep: 'connecting', wizardConnId: null }, true],
        [{ connecting: false, wizardStep: 'directory', wizardConnId: 'rc-a' }, true],
        [{ connecting: false, wizardStep: 'directory', wizardConnId: null }, false],
        [{ connecting: false, wizardStep: 'settings', wizardConnId: 'rc-a' }, false],
        [{ connecting: false, wizardStep: 'settings', wizardConnId: null }, false],
    ];
    for (const [setup, expect] of cases) {
        const r = runRemoteFns(setup, src + '\nreturn { f: wizardFlowActive };');
        assert.equal(r.f(), expect, '活跃判定错误: ' + JSON.stringify(setup));
    }
});

test('行为・stepLabel 用【字面量键】而非拼接（i18n 必须静态可提取，否则新增语言包必漏译）', () => {
    const src = cutFn(remoteCode, 'function stepLabel(step) {');
    // 拼接写法会让契约测试与翻译工具都提取不到键 → 派生出假键 step_
    assert.doesNotMatch(src, /'remote\.step_' \+/, '不得用字符串拼接构造 i18n 键');
    for (const k of ['remote.step_settings', 'remote.step_connecting', 'remote.step_directory']) {
        assert.ok(src.includes("'" + k + "'"), 'stepLabel 必须显式引用 ' + k);
    }
    const r = runRemoteFns({}, src + '\nreturn { f: stepLabel };');
    assert.equal(r.f('settings'), 'remote.step_settings');
    assert.equal(r.f('connecting'), 'remote.step_connecting');
    assert.equal(r.f('directory'), 'remote.step_directory');
    assert.equal(r.f('未知步'), 'remote.step_directory', '兜底到 directory 步名（不得抛错/返回 undefined）');
});

/* ============ 2) 连接成功【不关窗】：这是「每次都得重新连接」体感的直接解药 ============ */

test('行为接线・doConnect 成功后不 closeWizard，而是推进 directory 步并拉起弹窗', () => {
    const seg = remoteCode.slice(remoteCode.indexOf('function doConnect(cfg) {'));
    const okBranch = seg.slice(0, seg.indexOf('}, function (err) {'));
    /* 成功分支必须：记 connectionId + 置 directory 步 + 取消收起 + 拉起 open + 重渲染 */
    assert.match(okBranch, /wizardConnId = \(outcome && outcome\.connectionId\) \|\| null;/,
        '成功分支必须记下 connectionId（内嵌目录浏览器的 scope 归属要用）');
    assert.match(okBranch, /wizardStep = 'directory';/, '成功后必须推进到 directory 步');
    assert.match(okBranch, /wizardMinimized = false;/, '收起过也必须拉回（否则用户看不到选目录）');
    assert.match(okBranch, /el2\.classList\.add\('open'\)/, '必须把弹窗重新拉起（ZCode 同类修复的原因）');
    assert.match(okBranch, /renderWizard\(\);/, '必须重渲染以挂载内嵌目录树');
    /* 反向门禁：成功分支不得再关窗（旧实现的 closeWizard 正是投诉根源） */
    assert.doesNotMatch(okBranch, /closeWizard\(\)/,
        '连接成功不得关窗——关了用户就得回工作区下拉找「打开远程目录」再选一次');
    assert.doesNotMatch(okBranch, /destroyWizardFlow\(\)[\s\S]*renderWizard\(\)/,
        '正常成功路径不得走 destroyWizardFlow（它会把步骤复位回 settings）');
});

test('行为接线・doConnect 成功但无 connectionId（异常态）时必须清流程，不留半死向导', () => {
    const seg = remoteCode.slice(remoteCode.indexOf('function doConnect(cfg) {'));
    const okBranch = seg.slice(0, seg.indexOf('}, function (err) {'));
    assert.match(okBranch, /\} else \{\s*\n\s*destroyWizardFlow\(\);/,
        '拿不到 connectionId 时若继续推进，directory 步会因 rid=null 而无从浏览（mountEmbeddedBrowser 直接 return）→ 白屏');
});

test('行为接线・连接开始置 connecting 步并集中施态（只读观感+日志显形），失败回 settings 且保留日志', () => {
    /* codereview 2026-10-15 P1-4：旧断言锁 doConnect 里手动 classList.add('is-busy')，
       而那个旧形态恰恰不显日志区 → 主连接路径进度/失败原因全程不可见。
       施态唯一真源改为 applyWizardStep（toggle is-busy + 日志显形），此处锁新形态。 */
    const dc = cutFn(remoteCode, 'function doConnect(cfg) {');
    const dcHead = dc.slice(0, dc.indexOf('var isWsl'));
    assert.match(dcHead, /wizardStep = 'connecting';\s*\n\s*applyWizardStep\(\);/,
        '连接开始必须置 connecting 步并集中施态（日志区显形 + 只读观感一次到位）');
    assert.doesNotMatch(dcHead, /classList\.add\('is-busy'\)/, 'doConnect 不得再手动加 is-busy（施态逻辑两副本会漂移）');
    const apply = cutFn(remoteCode, 'function applyWizardStep() {');
    assert.match(apply, /body\.classList\.toggle\('is-busy', wizardStep === 'connecting'\)/,
        'connecting 步表单转只读观感由 applyWizardStep 的 toggle 唯一施态');
    /* 失败分支：必须回 settings（停在 connecting 会让表单锁在只读，用户改不了配置只能关掉重来）
       且【不得清日志】——logHasContent() 为真时日志区继续展示，用户才看得到失败原因 */
    const failSeg = remoteCode.slice(remoteCode.indexOf('logLine(GourdI18n.t(\'remote.connect_failed\'));'));
    const failBranch = failSeg.slice(0, failSeg.indexOf('if (cfg && cfg.channel !== \'wsl\''));
    assert.match(failBranch, /wizardStep = 'settings';/, '失败必须回 settings 步以便改配置重试');
    assert.match(failBranch, /applyWizardStep\(\);/, '失败必须集中施态（解除只读观感 + 日志继续可见）');
    assert.doesNotMatch(failBranch, /classList\.remove\('is-busy'\)/, '失败不得手动 remove is-busy（统一走 applyWizardStep toggle）');
    assert.doesNotMatch(failBranch, /innerHTML = ''/, '失败不得清空日志（用户要看失败原因）');
});

/* ============ 3) 收起 vs 关闭：两条语义不同的通道 ============ */

test('行为接线・收起（minimize）非破坏：只摘 open 类，不清步骤、不清连接、不销毁内嵌实例', () => {
    const src = cutFn(remoteCode, 'function minimizeWizard() {');
    assert.match(src, /wizardMinimized = true;/);
    assert.match(src, /classList\.remove\('open'\)/);
    assert.match(src, /refreshRemoteEntryIndicator\(\)/, '收起后必须点亮侧栏入口的「连接中」指示器');
    /* 反向门禁：收起绝不能做破坏性动作 */
    for (const banned of ['destroyWizardFlow', 'embeddedBrowser.destroy', "wizardStep = 'settings'", 'wizardConnId = null', 'doDisconnect']) {
        assert.ok(!src.includes(banned), '收起是非破坏通道，不得出现: ' + banned);
    }
});

test('行为接线・关闭走确认闸门（requestCloseWizard），且关闭不断开连接', () => {
    assert.match(remoteCode, /remote-wizard-close'\)\.addEventListener\('click', requestCloseWizard\)/,
        '关闭按钮必须绑到确认闸门，而不是直接 closeWizard');
    const src = cutFn(remoteCode, 'function requestCloseWizard() {');
    assert.match(src, /wizardCloseReason\(wizardStep, wizardConnId, !!connecting\)/, '必须用真实状态判据');
    assert.match(src, /window\.layConfirm\(msg,/, '走站点统一确认弹窗');
    /* 裸 confirm 禁令（桌面端规约）：layConfirm 内部已自带 fallbackConfirm 自绘遮罩，
       再写一层原生兜底既违规又冗余（首版就写了，被全仓门禁抓到） */
    assert.doesNotMatch(src, /window\.confirm\s*\(/, '不得用裸 window.confirm（桌面端规约 + layConfirm 已有降级）');
    /* destroyWizardFlow 不得断开连接：连接是注册表资产（可能被别的工作区引用计数持有） */
    const d = cutFn(remoteCode, 'function destroyWizardFlow() {');
    assert.doesNotMatch(d, /doDisconnect/, '结束向导流程不得断开连接（断开有专门入口）');
    assert.doesNotMatch(d, /remoteDisconnect/, '同上：不得直接调 IPC 断开');
    assert.match(d, /wizardStep = 'settings';/, '清流程要复位步骤（下次打开从头开始）');
    assert.match(d, /wizardMinimized = false;/, '清流程要复位收起态（否则指示器残留）');
});

test('行为接线・重开恢复步骤：流程活跃→回到当前步；空闲→回 settings（消灭「每次都得重新连接」）', () => {
    const src = cutFn(remoteCode, 'function openWizard() {');
    assert.match(src, /if \(!wizardFlowActive\(\) && wizardStep !== 'settings'\) wizardStep = 'settings';/,
        '只有【空闲】才复位到 settings；活跃（连接中/已连接未选目录）必须保留当前步');
    assert.match(src, /wizardMinimized = false;/, '重开必须清收起态');
    assert.match(src, /refreshRemoteEntryIndicator\(\)/, '重开后指示器应熄灭');
});

test('行为接线・侧栏入口「连接中」指示器：仅收起且流程活跃时点亮（幂等刷新）', () => {
    const src = cutFn(remoteCode, 'function refreshRemoteEntryIndicator() {');
    assert.match(src, /var on = wizardMinimized && wizardFlowActive\(\);/, '判据必须是「收起 且 活跃」');
    assert.match(src, /classList\.toggle\('is-connecting', on\)/, '用 toggle 保证幂等（可重复调）');
    assert.match(src, /removeAttribute\('data-connecting-label'\)/, '非活跃时必须清掉标签（否则残留误导）');
    /* 入口按钮由 renderDropdown 动态重建 → 重建后类名会丢，必须补刷 */
    assert.match(workspaceCode, /window\.refreshRemoteEntryIndicator === 'function'/, 'workspace 渲染后必须补刷指示器');
});

/* ============ 4) 「连接另一台」：用户投诉 1 的正面回答 ============ */

test('行为接线・directory 步有「连接另一台」入口，且回退不断开已连上的那台', () => {
    assert.match(remoteCode, /remote-dir-another/, '必须有「连接另一台」按钮');
    assert.match(remoteCode, /remote\.connect_another/, '按钮文案走 i18n');
    const seg = remoteCode.slice(remoteCode.indexOf("var anotherBtn = el.querySelector('.remote-dir-another');"));
    /* 终止锚必须用【代码】而非注释：remoteCode 已剥注释，注释锚 indexOf=-1 会切到文件尾
       （把后面 onRemoteState 等无关代码吞进来，doesNotMatch 必假红）。 */
    const branch = seg.slice(0, seg.indexOf("el.querySelector('#remoteConnectBtn')"));
    assert.match(branch, /embeddedBrowser\.destroy\(\)/, '切走前必须销毁内嵌实例（否则重进时容器已空而实例仍指向旧对象）');
    assert.match(branch, /wizardConnId = null;/, '清「待选目录」的连接指针（但不动 connectionsById 注册表）');
    assert.match(branch, /wizardStep = 'settings';/, '回到配置步去连第二台');
    /* 反向门禁：不得断开第一台——它可能已被别的工作区引用计数持有 */
    assert.doesNotMatch(branch, /doDisconnect/, '连第二台不得断开第一台');
    assert.doesNotMatch(branch, /connectionsById\[/, '不得直接改连接注册表');
});

test('多连接并存：applyConnection 追加注册且不抢 active（连第二台时第一台继续可用）', () => {
    const seg = remoteCode.slice(remoteCode.indexOf('function applyConnection(outcome) {'));
    const body = seg.slice(0, seg.indexOf('function KEY_REJECT_MARKER') > 0 ? seg.length : seg.indexOf('\n    /* 指纹拒绝识别锚'));
    assert.match(body, /connectionsById\[id\] = outcome;/, '必须按 id 追加进注册表（不是覆盖）');
    assert.match(body, /setActiveId\(activeIdStored\);/,
        '新连接不得抢 active（连接 ≠ 切换环境）：activeId 保持原值，用户选着的工作区不被无端打断');
    assert.doesNotMatch(body, /setActiveId\(id\)/, '不得把新连接自动置为 active（那会让无归属请求全灌进新远端）');
});

/* ============ 5) 已保存主机一键直连 ============ */

test('行为接线・已保存主机点击【直接发起连接】，而非只回填表单', () => {
    const seg = remoteCode.slice(remoteCode.indexOf("el.querySelectorAll('.remote-host-item').forEach"));
    /* 终止锚用编辑按钮监听的代码起点（注释锚在剥注释后不存在，见上条同理） */
    const branch = seg.slice(0, seg.indexOf("el.querySelectorAll('.remote-host-edit')"));
    assert.match(branch, /connectSavedHost\(h\);/, '主行点击必须直连（旧实现只回填字段，用户还得再点一次连接）');
    assert.doesNotMatch(branch, /document\.getElementById\('remoteHost'\)\.value = h\.host;/,
        '主行点击分支不应再走「回填表单」老路（那是编辑按钮的职责）');
});

test('行为・connectSavedHost：敏感字段留空交给 Rust autofill_secret 回填，且先渲染再连', () => {
    const src = cutFn(remoteCode, 'function connectSavedHost(h) {');
    assert.match(src, /password: ''/, 'SSH 密码留空：由 Rust 侧 autofill_secret 从 OS 凭据库回填');
    assert.match(src, /passphrase: ''/, '私钥口令同理留空');
    assert.match(src, /channel: 'wsl', host: h\.host, user: h\.user/, 'WSL 通道只需 host(distro)+user');
    assert.match(src, /keyPath: h\.keyPath \|\| ''/, '私钥路径是非敏感字段，应带上');
    /* 顺序不变量：doConnect 要往 #remoteConnectLog 写行，故必须先 renderWizard 让日志区存在 */
    const iRender = src.indexOf('renderWizard();');
    const iConnect = src.indexOf('doConnect(cfg);');
    assert.ok(iRender > 0 && iConnect > iRender, '必须先渲染（让日志区存在）再发起连接，否则进度行全丢');
    /* codereview 2026-10-15 P1-4：旧断言锁的是 connectSavedHost 里的 logBox0 补丁，
       而主连接路径（点「连接」按钮）没有这行 → 日志区全程 display:none，进度/失败原因
       不可见。补丁已删，显形职责集中在 doConnect 进入 connecting 步时的 applyWizardStep，
       故断言也改锁集中施态（覆盖所有进入 connecting 的路径）。 */
    assert.doesNotMatch(src, /logBox0/, '直连路径不得再自带日志显形补丁（职责在 doConnect 集中施态）');
    const dc = cutFn(remoteCode, 'function doConnect(cfg) {');
    const dcHead = dc.slice(0, dc.indexOf('var isWsl'));
    assert.match(dcHead, /wizardStep = 'connecting';\s*\n\s*applyWizardStep\(\);/,
        'doConnect 进入 connecting 步必须集中施态（日志区显形 + is-busy），否则主路径看不到进度');
});

test('行为接线・「编辑」次级入口独立存在且与直连互不干扰', () => {
    assert.match(remoteCode, /remote-host-edit/, '必须有编辑按钮（端口/认证方式变了、或需要补密码时用）');
    assert.match(remoteCode, /remote\.host_edit/, '编辑按钮 title 走 i18n');
    /* 主行点击必须放过编辑按钮，否则点编辑会同时触发直连（两个动作打架） */
    const seg = remoteCode.slice(remoteCode.indexOf("el.querySelectorAll('.remote-host-item').forEach"));
    assert.match(seg, /if \(e\.target\.closest\('\.remote-host-edit'\)\) return;/,
        '主行点击必须放过编辑按钮（同 remove 按钮的既有处理方式）');
    assert.match(remoteCode, /el\.querySelectorAll\('\.remote-host-edit'\)\.forEach/, '编辑按钮必须自己有监听');
});

/* ============ 6) 目录浏览器渲染核（弹窗/内嵌两态共用） ============ */

test('行为接线・新建文件夹走 /projects/mkdir【而非 create】（create 会顺带登记项目 → 垃圾条目）', () => {
    const src = cutFn(codeCode, 'function mkdirRequest(parent, name, scopeQ) {');
    assert.match(src, /'\/web\/chat\/projects\/mkdir'/, '必须打 mkdir 端点');
    assert.doesNotMatch(src, /projects\/create/,
        '绝不能用 create：它末尾 return add(...) 会把新目录登记进项目列表，'
        + '导航途中每建一层就往工作区下拉塞一条垃圾条目（远端更糟：写进远端 projects.json）');
    assert.match(src, /browseQuery\('', scopeQ\)/, 'mkdir 必须带 scope（在哪台机器浏览就在哪台建）');
    /* 后端端点确实存在（前后端契约对齐，防「前端打一个不存在的端点」） */
    assert.match(webCtrl, /@Mapping\("\/web\/chat\/projects\/mkdir"\)/, 'WebController 必须有 mkdir 映射');
    assert.match(webCtrl, /projectService\.mkdir\(parent, name\)/, '必须转发到 ProjectService.mkdir');
});

test('行为・mkdirRequest 透传后端 description（Solon 失败也是 HTTP 200，业务码在 body.code）', () => {
    const src = cutFn(codeCode, 'function mkdirRequest(parent, name, scopeQ) {');
    assert.match(src, /resp\.code === 200/, '必须校验 body.code（Solon Result 语义）');
    assert.match(src, /resp\.description/, '失败原因必须原样透传（「目录已存在」比统一文案有用得多）');
    /* 网络失败走 resolve({error}) 而非 reject：调用方无需 catch，避免未捕获 rejection */
    assert.match(src, /\.fail\(function \(\) \{ resolve\(\{ error:/, '网络失败必须 resolve 而非 reject');
});

test('行为・渲染核用 host.querySelector 而非 getElementById（内嵌态与弹窗态可能同屏并存）', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    assert.match(src, /host\.querySelector\('\[data-role="list"\]'\)/, '列表必须限定在 host 内查找');
    assert.match(src, /host\.querySelector\('\[data-role="path"\]'\)/, '路径框同上');
    assert.doesNotMatch(src, /getElementById/,
        '渲染核不得用 getElementById：向导内嵌与 layer 弹窗可能同时存在于文档，全局 id 查找会串到另一个实例');
});

test('行为・请求竞态守卫：单调递增 reqId，过期响应必须丢弃', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    assert.match(src, /var reqId = \+\+state\.reqId;/, '每次 browse 递增 reqId');
    const guards = src.match(/reqId !== state\.reqId/g) || [];
    assert.ok(guards.length >= 2, '成功回调与失败回调都必须校验 reqId（只守一边等于没守），实际 ' + guards.length);
    assert.match(src, /if \(!state\.alive \|\| reqId !== state\.reqId\) return;/,
        '快速连点目录时较早的 browse 可能后返回，过期响应会覆盖最新导航状态（列表与路径框不一致）');
});

test('行为・destroy 置 alive=false 并清空容器（防内嵌实例被销毁后仍写 DOM）', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    assert.match(src, /destroy: function \(\) \{ state\.alive = false; host\.innerHTML = ''; \}/,
        'destroy 必须置 alive 并清空；异步回调回来时靠 alive 判定放弃写入');
    assert.match(src, /state = \{[^}]*alive: true/, 'state 初始必须 alive:true');
});

test('行为・内联新建：起点态（无 current）必须明确提示而非静默失败；成功后【进入】新目录', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    const beginCreate = src.slice(src.indexOf('function beginCreate() {'));
    const bc = beginCreate.slice(0, beginCreate.indexOf('function pick() {'));
    assert.match(bc, /if \(!state\.current\) \{[\s\S]{0,120}please_enter_dir/,
        'Windows 起点是盘符列表（current 为空），此时无处可建，必须提示而不是静默');
    assert.match(bc, /if \(state\.creating\) return;/, '重复点击不得插入多行输入框');
    assert.match(bc, /input\.disabled = true;/, '提交期间必须禁用输入（防双击重复建）');
    assert.match(bc, /browse\(target\);/, '建成功后必须进入新目录（用户的下一步几乎总是往里走）');
    assert.match(bc, /r\.path \|\|/, '优先用后端回传的规范路径（大小写/分隔符已归一），本地拼接只是兜底');
    /* Esc 必须 stopPropagation：向导也监听 Esc（关窗），不拦会让「取消新建」连带关掉整个向导 */
    assert.match(bc, /e\.stopPropagation\(\); endCreate\(\);/,
        '内联输入的 Esc 必须阻止冒泡，否则「取消新建」会连带关闭整个向导（真实交互冲突）');
});

test('行为接线・渲染核带「新建文件夹」工具栏按钮（用户投诉 2 的正面回答）', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    assert.match(src, /data-act="mkdir"/, '工具栏必须有新建按钮');
    assert.match(src, /code\.new_folder/, '按钮文案走 i18n');
    assert.match(src, /else if \(act === 'mkdir'\) beginCreate\(\);/, '按钮必须接到 beginCreate');
    assert.match(src, /dir-picker-mkdir-row/, '内联输入行（不另开弹窗，不打断浏览上下文）');
    assert.match(src, /code\.new_folder_placeholder/, '输入框 placeholder 走 i18n');
    /* 事件必须委托（内联行是动态插入的，逐按钮绑定会漏） */
    assert.match(src, /host\.addEventListener\('click'/, '必须用事件委托（动态插入的行才能被覆盖）');
});

test('行为・渲染核默认自动 browse 起点，且可被宿主关掉（内嵌态由向导控制时机）', () => {
    const src = cutFn(codeCode, 'function renderDirBrowserInto(host, opts) {');
    assert.match(src, /if \(opts\.autoBrowse !== false\) browse\(''\);/, '默认自动加载起点，autoBrowse:false 可关');
    assert.match(src, /return \{\s*\n\s*browse: browse,\s*\n\s*pick: pick,/, '必须暴露 browse/pick 供宿主驱动');
    assert.match(src, /currentPath: function \(\) \{ return state\.current; \}/, '暴露当前路径（宿主校验用）');
});

/* ============ 7) 向导内嵌目录树 ============ */

test('行为接线・mountEmbeddedBrowser 复用 app-code 的渲染核（不另写一份目录浏览器）', () => {
    const src = cutFn(remoteCode, 'function mountEmbeddedBrowser(host) {');
    assert.match(src, /window\.renderDirBrowserInto\(host, \{/,
        '必须复用渲染核：新建文件夹/竞态守卫/scope 归属任一改动都会漏掉一边（同缺陷两副本）');
    assert.match(src, /'&__scope=id:' \+ encodeURIComponent\(rid\)/,
        'scope 必须显式声明为该连接（encodeURIComponent：前端 encodeURIComponent 会把冒号编成 %3A，'
        + 'Rust route_for 侧必须解码才命中，两端已对齐）');
    assert.match(src, /showCancel: false/, '向导自带收起/关闭，内嵌层不必再来一个取消（重复出口会困惑）');
    /* 渲染核不可用时的降级：退回弹窗式选择器（功能不缺，只是多一次弹窗，好过白屏） */
    assert.match(src, /typeof window\.renderDirBrowserInto !== 'function'/, '必须有存在性守卫');
    assert.match(src, /window\.openDirPicker\(onPicked, scopeQ\);/, '降级路径仍要能选目录（不得直接放弃）');
});

test('行为接线・选定目录 → 登记到【选定那台】→ 补临时 _scope → 选中 → 关窗', () => {
    const src = cutFn(remoteCode, 'function finishWizardWithDir(rid, picked) {');
    assert.match(src, /'\/web\/chat\/projects\/add\?__scope=id:' \+ encodeURIComponent\(rid\)/,
        '登记必须带选定那台的 scope（两台在线时 rid ≠ activeId，写错会让该目录后续读写跳到另一台机器）');
    assert.match(src, /if \(resp && resp\.code !== 200\) \{/, '必须校验 body.code（Solon 失败也是 HTTP 200）');
    /* 失败时不得关窗：让用户看到原因并可重选（关了就前功尽弃） */
    const failPart = src.slice(src.indexOf('if (resp && resp.code !== 200) {'));
    /* 终止锚用补 _scope 的代码起点（注释锚在剥注释后不存在） */
    const failBranch = failPart.slice(0, failPart.indexOf('window.__gourdRegisterRemoteProject'));
    assert.doesNotMatch(failBranch, /destroyWizardFlow\(\)/, '登记失败不得关窗（用户要看到原因并重选）');
    assert.match(src, /window\.__gourdRegisterRemoteProject\(picked, rid\)/,
        '必须补临时 _scope 记录：notifyProjectsChanged 的重拉是异步的，紧接着的选中会查到旧缓存');
    assert.match(src, /window\.applyChatWorkspace\(picked\)/, '登记成功后选中该工作区');
});

test('行为接线・app-workspace 暴露统一登记钩子，且「打开远程目录」分支已改用（消除副本）', () => {
    assert.match(workspaceCode, /window\.__gourdRegisterRemoteProject = function \(path, scopeId\)/,
        '必须暴露钩子（app-remote 闭包读不到 app-workspace 的 projectsCache）');
    const src = cutFn(workspaceCode, 'function registerProjectScope(path, scopeId) {');
    assert.match(src, /var scope = \(scopeId && scopeId !== 'local'\) \? scopeId : 'local';/,
        'null/空一律归一为 local（宁可按本地也不把「当前选中的那台」当归属）');
    assert.match(src, /if \(p && pathKey\(p\.path\) === pk\) \{ p\._scope = scope; return; \}/,
        '已存在同路径则更新 _scope 并返回（幂等；重拉竞态下不会 push 出重复条目）');
    assert.match(src, /projectsCache\.push\(\{ path: path, name: baseName\(path\), _scope: scope \}\);/,
        'name 必须走 baseName（与列表渲染同口径，不得各自 split 一遍）');
    /* 既有「打开远程目录」分支必须复用共用登记链（否则就是同一逻辑的两个副本）。
       2026-10-16 再收编一层：分支不再直接调 registerProjectScope，而是走
       registerWorkspacePath(picked, rid, true)（内部调 registerProjectScope +
       body.code 校验 + 广播单点）；断言锁「走共用链」且「不得内联 push/ajax」。 */
    const seg = workspaceCode.slice(workspaceCode.indexOf("var remoteOpen = t.closest('.workspace-dropdown .workspace-remote-open-btn');"));
    const branch = seg.slice(0, seg.indexOf('var item = t.closest'));
    assert.match(branch, /registerWorkspacePath\(picked, rid, true\);/, '「打开远程目录」分支必须复用共用登记链');
    assert.doesNotMatch(branch, /projectsCache\.push\(\{ path: picked/,
        '不得再内联 push（与向导分支各写一份 = 日后必然漂移，含 name 计算口径不一致）');
    assert.doesNotMatch(branch, /\$\.ajax\(/, '不得再内联登记 ajax（单点纪律）');
    const reg = cutFn(workspaceCode, 'function registerWorkspacePath(picked, scopeId, autoSelect) {');
    /* scopeId || 'local'：两分支（远端/本地）临时记录都走同一 helper（它带幂等
       去重）；内联 push 无去重，重拉竞态下会留重复条目 */
    assert.match(reg, /registerProjectScope\(picked, scopeId \|\| 'local'\);/, '共用链内部必须复用同一 helper（临时 _scope 记录单点 + 幂等）');
    assert.doesNotMatch(reg, /projectsCache\.push\(/, '登记链内不得内联 push（无幂等去重）');
});

/* ============ 8) 向导面板结构 ============ */

test('行为接线・面板 head 有收起+关闭双按钮，且收起按钮不复用关闭的类名', () => {
    /* WHY 严格：renderWizard 末尾按 .remote-wizard-close 取【第一个】元素绑「关闭」，
       若收起按钮也带该类且排在前，querySelector 会命中收起 → 关闭逻辑绑错按钮（真实回归）。 */
    assert.match(remoteCode, /class="remote-wizard-min"/, '收起按钮必须有独立类名');
    /* 起点锚不得带收尾单引号：源码拼接串是 '<div class="remote-wizard-head"><span>'…
       带引号的锚 indexOf=-1 → slice(-1, end) 从文件倒数第 1 字符切起，head 段为空必假红。 */
    const headSeg = remoteCode.slice(remoteCode.indexOf("'<div class=\"remote-wizard-head\">"),
        remoteCode.indexOf('+ stepsHtml()'));
    const iMin = headSeg.indexOf('remote-wizard-min');
    const iClose = headSeg.indexOf('remote-wizard-close');
    assert.ok(iMin > 0 && iClose > iMin, 'head 内收起在前、关闭在后（视觉顺序），但类名必须不同');
    assert.doesNotMatch(headSeg, /remote-wizard-min[^"]*remote-wizard-close/, '收起按钮不得同时带关闭类名');
    assert.match(remoteCode, /remote\.minimize/, '收起按钮 title 走 i18n');
    assert.match(remoteCode, /stepsHtml\(\)/, '面板必须有步骤条');
    assert.match(remoteCode, /id="remoteStepBody"/, '必须有 directory 步的内嵌容器');
});

test('行为接线・applyWizardStep：directory 步隐藏表单但不清值；connecting 步只读观感；日志区不被藏', () => {
    const src = cutFn(remoteCode, 'function applyWizardStep() {');
    assert.match(src, /body\.style\.display = \(wizardStep === 'directory'\) \? 'none' : '';/,
        'directory 步只【隐藏】表单（值保留），用户点步骤条回退即可继续改配置，不必重填');
    assert.match(src, /body\.classList\.toggle\('is-busy', wizardStep === 'connecting'\)/, 'connecting 步转只读观感');
    assert.match(src, /var showLog = \(wizardStep === 'connecting' \|\| wizardStep === 'directory' \|\| logHasContent\(\)\);/,
        '切步不得把已产生的日志藏起来（否则用户回到弹窗就看不到刚才的失败原因）');
    /* codereview 2026-10-15 P1-1：旧断言锁的 mountEmbeddedBrowser(stepBody) 正是缺陷形态——
       渲染核首行 host.innerHTML='' 会把 stepBody 里同批渲染的成功横幅（含「连接另一台」）
       一起清掉。正确挂载点是专设内层容器 #remoteDirHost（横幅的前置兄弟节点）。 */
    assert.match(src, /var hostWrap = el\.querySelector\('#remoteDirHost'\);/,
        '必须取专设内层容器作挂载点（不得用 stepBody 本身）');
    assert.match(src, /if \(wizardStep === 'directory' && hostWrap && !embeddedBrowser\) mountEmbeddedBrowser\(hostWrap\);/,
        '内嵌浏览器只挂一次且挂内层容器（重复挂载会覆盖容器并泄漏旧实例；挂 stepBody 会清掉横幅）');
    assert.doesNotMatch(src, /mountEmbeddedBrowser\(stepBody\)/, '禁止回退到挂 stepBody（会清掉成功横幅与「连接另一台」）');
});

test('行为接线・directory 步横幅与内嵌容器是兄弟节点（横幅不被渲染核清掉）', () => {
    /* 结构不变量：.remote-dir-ok（含「连接另一台」）与 #remoteDirHost 同为 #remoteStepBody
       的直接子节点，且横幅在前。若横幅被移进 #remoteDirHost，渲染核 innerHTML 覆盖即清掉它
       ——用户「连了这台还想连别的」的入口会在 DOM 里不可达（P1-1 的另一种复发形态）。 */
    const seg = remoteCode.slice(remoteCode.indexOf("'<div class=\"remote-wizard-stepbody\" id=\"remoteStepBody\""));
    const bodySeg = seg.slice(0, seg.indexOf("+ '</div>'"));
    const iOk = bodySeg.indexOf('remote-dir-ok');
    const iWrap = bodySeg.indexOf('id="remoteDirHost"');
    assert.ok(iOk > 0 && iWrap > iOk, '横幅必须在 stepBody 内且先于内嵌容器');
    assert.match(bodySeg, /remote-dir-another/, '横幅内必须有「连接另一台」按钮');
    /* 横幅不得嵌在 remoteDirHost 容器内部 */
    const wrapSeg = bodySeg.slice(iWrap);
    assert.doesNotMatch(wrapSeg, /remote-dir-ok/, '横幅不得是 remoteDirHost 的子节点（会被渲染核清掉）');
});

test('行为接线・连接途中确认关闭后，在途成功分支不得复活弹窗（wizardCancelled 闸）', () => {
    /* codereview 2026-10-15 P1-2：旧实现成功分支无条件 add('open')+renderWizard，
       用户确认「停止并关闭」后在途 Promise 一 resolve 向导就自动弹出（关闭承诺被击穿）。
       三侧都要锁：声明 + destroy 置真 + 成功分支受闸；且 doConnect 起始必须复位
       （否则第二轮连接成功后永远不拉回弹窗，等于把缺陷镜像成另一个）。 */
    assert.match(remoteCode, /var wizardCancelled = false;/, '必须有取消闸变量');
    const dc = cutFn(remoteCode, 'function doConnect(cfg) {');
    assert.match(dc, /connecting = true;\s*\n\s*wizardCancelled = false;/, '新一轮连接必须复位取消闸');
    const destroy = cutFn(remoteCode, 'function destroyWizardFlow() {');
    assert.match(destroy, /wizardCancelled = true;/, '关闭流程必须置真取消闸');
    const succ = dc.slice(dc.indexOf('if (wizardConnId) {'), dc.indexOf('destroyWizardFlow();   // 无 connectionId'));
    assert.match(succ, /if \(!wizardCancelled\) \{/, '成功分支拉回弹窗必须受取消闸保护');
    /* 取消只闸弹窗复活，不闸连接登记：连接是注册表资产（applyConnection 在闸外） */
    const iApply = dc.indexOf('applyConnection(outcome);');
    const iGate = dc.indexOf('if (!wizardCancelled) {');
    assert.ok(iApply > 0 && iGate > iApply, 'applyConnection 必须在闸外（关窗不作废已成功的连接）');
});

test('行为接线・步骤条可回退，且回退不断开连接', () => {
    const src = cutFn(remoteCode, 'function stepsHtml() {');
    /* 实况形态：cls 三元一次算出（i===cur→active、i<cur→done），data-goto 另按 i<cur 挂；
       旧断言抄的是「嵌套三元」假想形态，与源码不符必红。语义不变量=active 仅当前步、done 仅已过步。 */
    assert.match(src, /var cls = i === cur \? ' active' : \(i < cur \? ' done' : ''\);/,
        '当前步 active、已过步 done、未来步无类名');
    assert.match(src, /\(i < cur \? ' data-goto="' \+ s \+ '"' : ''\)/, '只有已走过的步才可点回退');
    const handler = remoteCode.slice(remoteCode.indexOf("el.querySelectorAll('.remote-step[data-goto]').forEach"));
    /* 终止锚用「连接另一台」按钮取元素的代码起点（注释锚在剥注释后不存在） */
    const hb = handler.slice(0, handler.indexOf('var anotherBtn'));
    assert.match(hb, /embeddedBrowser\.destroy\(\)/, '回退前必须销毁内嵌实例（否则重进时容器已空而实例指向旧对象）');
    assert.match(hb, /wizardStep = target;\s*\n\s*renderWizard\(\);/, '回退后必须重渲染');
    assert.doesNotMatch(hb, /doDisconnect/, '回退不得断开连接（物理连接由 Rust 注册表持有，断开有专门入口）');
    assert.doesNotMatch(hb, /wizardConnId = null/, '回退改配置时保留连接指针（与「连接另一台」不同：那个才清）');
});

/* ============ 9) 底部遮挡（用户投诉 4）：与症状对应的顺序不变量 ============ */

test('三个动作按钮齐备且「远程连接」在最后（被裁时首当其冲的正是用户报的那个）', () => {
    const order = ['workspace-add-btn', 'workspace-remote-open-btn', 'workspace-remote-btn'];
    let last = -1;
    for (const cls of order) {
        const i = workspaceCode.indexOf('workspace-action-btn ' + cls);
        assert.ok(i > 0, '缺少动作按钮 .' + cls);
        assert.ok(i > last, '动作按钮顺序被打乱：.' + cls + ' 应排在后面');
        last = i;
    }
    assert.match(workspaceCode, /hasRemoteConnection\(\)[\s\S]{0,80}workspace-remote-open-btn/,
        '「打开远程目录」必须由 hasRemoteConnection() 门控（无连接时不该占位——它正是把内容高度推过上限的第三个按钮）');
});

test('CSS・列表区双层可压缩（遮挡修复的物理基础，详见 workspace-dropdown-bottom-occlusion）', () => {
    const css = readStatic('css', 'code.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const declsOf = (cls) => {
        const re = new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}');
        const m = css.match(re);
        assert.ok(m, '.' + cls + ' 规则缺失');
        return m[1];
    };
    assert.match(declsOf('workspace-list-container'), /min-height:\s*0/, '外层必须可压缩');
    assert.match(declsOf('workspace-list-scroll'), /min-height:\s*0/, '内层必须可压缩（单层修法会让列表末项点不到）');
});

/* ============ 10) i18n 完整性（新增键 12 语言全齐） ============ */

test('i18n・新增的 code.* 与 remote.* 键必须 12 语言包全齐', () => {
    const LOCALES = path.join(staticRoot, 'locales');
    const needCode = ['new_folder', 'new_folder_placeholder', 'new_folder_empty', 'new_folder_ok'];
    const needRemote = ['step_settings', 'step_connecting', 'step_directory', 'minimize',
        'entry_connecting', 'connect_another', 'host_edit',
        'close_confirm_connecting', 'close_confirm_connected'];
    const langs = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
    assert.equal(langs.length, 12, '必须 12 个语言包');
    for (const lang of langs) {
        const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
        for (const k of needCode) {
            assert.ok(data.code && String(data.code[k] || '').trim(), lang + '.code.' + k + ' 缺失');
        }
        for (const k of needRemote) {
            assert.ok(data.remote && String(data.remote[k] || '').trim(), lang + '.remote.' + k + ' 缺失');
        }
    }
});

test('i18n・源码引用的 code.new_folder* 键不得用拼接构造（静态可提取）', () => {
    assert.doesNotMatch(codeCode, /GourdI18n\.t\('code\.new_folder' \+/, '不得拼接 i18n 键');
    for (const k of ['code.new_folder', 'code.new_folder_placeholder', 'code.new_folder_empty', 'code.new_folder_ok']) {
        assert.ok(codeCode.includes("'" + k + "'"), '必须显式引用 ' + k);
    }
});
