'use strict';
/* ===== 终端 Windows 版本 banner 重连去重契约 =====
 * 背景（用户实测截图定罪）：后端 TerminalGate 对【每条新连接】首帧补发 Windows
 * 版本横幅（cmd /K 形态自身不打印），而前端关面板只断连、保留输出缓冲、重开懒重连
 * → 每「开→关→开」一轮就在回滚缓冲里叠一份 banner+提示符。
 * 修复：app-terminal.js per-tab bannerSeen + 连接级首帧窗口去重
 * （仅首帧识别 banner：首展落标记、重连补发丢弃；非首帧的 banner 形态
 *  一律当用户输出展示）。
 *
 * 测试纪律（延续本仓教训）：
 *  - 行为级断言用 vm 真执行整模块 + 假 WebSocket 驱动 onopen/onmessage，
 *    不靠「源码里出现过某字符串」定罪或赦免；
 *  - 形状断言只做双侧锁（声明侧 createTab + 消费侧 onmessage + 重置侧 restart），
 *    防止「删掉消费行但注释里还留着名字」的假绿；
 *  - 去重判据必须精确匹配 banner 本体：宽松前缀会吞掉用户命令的合法回显
 *    （type ver.txt / echo Microsoft Windows），故有专门的负样本用例。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STATIC = path.resolve(__dirname, '../../../src/main/resources/static');
const termJs = fs.readFileSync(path.join(STATIC, 'js', 'app-terminal.js'), 'utf8');

/* 后端首帧 banner 的真实形态（TerminalGate.windowsBanner 取无参 cmd 输出首两行，
   Windows 管道行尾为 \r\n）：两行 + 换行收尾。 */
const BANNER = 'Microsoft Windows [版本 10.0.26300.9711]\r\n' +
    '(c) Microsoft Corporation。保留所有权利。\r\n';

// ---------- 最小 DOM / WebSocket 桩 ----------

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeEl(tag) {
    const el = {
        tagName: tag, type: '', className: '', id: '', title: '', value: '', size: 0,
        scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 200,
        children: [], childNodes: [], listeners: {}, _html: '', _text: null,
        style: { setProperty() {} },
        classList: { add() {}, remove() {}, contains() { return false; } },
        set textContent(v) { this._text = v; this._html = esc(v); },
        get textContent() { return this._text == null ? '' : this._text; },
        set innerHTML(v) { this._html = v; this._text = null; this.children = []; this.childNodes = []; },
        get innerHTML() { return this._html; },
        insertAdjacentHTML(pos, html) { this._html += html; this.childNodes.push({ html }); },
        appendChild(c) { this.children.push(c); this.childNodes.push(c); return c; },
        removeChild(c) {
            let i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1);
            i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1);
            return c;
        },
        get firstChild() { return this.childNodes[0] || null; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        setAttribute() {}, getAttribute() { return null; },
        querySelector() { return makeEl('span'); },
        contains() { return false; },
        focus() {}
    };
    return el;
}

function makeWsClass() {
    const instances = [];
    class WS {
        constructor(url) {
            instances.push(this);
            this.url = url;
            this.readyState = 0; // CONNECTING
            this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
            this.sentFrames = [];
        }
        send(s) { this.sentFrames.push(s); }
        close() { this.readyState = 3; if (this.onclose) this.onclose(); }
        // ---- 测试驱动 ----
        open() { this.readyState = 1; if (this.onopen) this.onopen(); }
        emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    }
    WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
    return { WS, instances };
}

function boot() {
    const els = {};
    for (const id of ['codeTerminalPane', 'codeTerminalResizeHandle', 'codeTerminalBody',
        'codeTerminalTabs', 'codeTerminalNewBtn', 'codeTerminalClearBtn',
        'codeTerminalRestartBtn', 'codeTerminalCloseBtn', 'filerTerminalBtn']) {
        els[id] = makeEl('div');
    }
    const { WS, instances } = makeWsClass();
    const sandbox = {
        document: {
            getElementById: (id) => els[id] || null,
            createElement: (tag) => makeEl(tag),
            addEventListener() {},
            querySelector: () => null,
            body: makeEl('body'),
            documentElement: makeEl('html')
        },
        window: {
            addEventListener() {},
            location: { protocol: 'http:', host: 'localhost:1' },
            getSelection: () => ''
        },
        WebSocket: WS,
        localStorage: { getItem: () => '0', setItem() {} },
        GourdI18n: { t: (k) => k },
        /* 定时器全部 no-op：restart 的 8s 超时定时器若真跑会在测试期间杀掉
           新建连接（myToken 未过期），启动恢复定时器亦无意义；本套用例的
           断言全为同步路径，不需要任何延迟回调。 */
        setTimeout: () => 0,
        clearTimeout: () => {},
        console
    };
    vm.runInNewContext(termJs, sandbox, { filename: 'app-terminal.js' });
    return { sandbox, els, sockets: instances };
}

/** 当前激活 tab 的回滚缓冲文本（mountTabBody 把 bufEl 挂为 body 首个子节点）。 */
function bufHtml(els) {
    const buf = els.codeTerminalBody.childNodes[0];
    return buf ? buf.innerHTML : '';
}
function countOf(html, needle) {
    let n = 0, i = html.indexOf(needle);
    while (i >= 0) { n++; i = html.indexOf(needle, i + needle.length); }
    return n;
}

/** 打开终端并接通当前连接，返回该连接的假 socket。 */
function openAndConnect(ctx) {
    ctx.sandbox.window.toggleCodeTerminal();
    const ws = ctx.sockets[ctx.sockets.length - 1];
    ws.open();
    return ws;
}

// ---------- 行为级：开关轮回不得叠 banner ----------

test('首开展示一次 banner（首帧补发不得被误吞）', () => {
    const ctx = boot();
    const ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1,
        '首帧 banner 必须展示且仅一次');
});

test('开→关→开重连补发的 banner 必须丢弃（用户截图回归）', () => {
    const ctx = boot();
    let ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1);

    // 关面板（断连、保留缓冲）→ 重开（懒重连）→ 后端按协议再补发一次 banner
    ctx.sandbox.window.toggleCodeTerminal();
    ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1,
        '重连补发的 banner 叠进保留缓冲 = 用户截图缺陷');

    // 再来两轮开关，仍只有一份
    for (let i = 0; i < 2; i++) {
        ctx.sandbox.window.toggleCodeTerminal();
        ws = openAndConnect(ctx);
        ws.emit({ type: 'output', data: BANNER });
    }
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1,
        '多轮开关不得累积 banner');
});

test('非首帧的 banner 形态必须当用户输出展示（cat 回显负样本）', () => {
    const ctx = boot();
    const ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    // 用户 cat 一个内容恰为两行 banner 的文件：该回显不是首帧，必须展示。
    // 旧判据「seen 后任何时刻命中形态都丢」会静默吞掉它。
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 2,
        '非首帧的 banner 形态是用户输出，不得被去重吞掉');
});

test('三行/单行形态不是 banner（与后端切片严格同口径）', () => {
    const ctx = boot();
    const ws = openAndConnect(ctx);
    // 后端切片为 substring(0, idx2+1) 且 idx2>idx+1、raw[idx+1]!='\n'：
    // 三行与单行形态后端永不产出；前端若误判为首帧 banner 会吞掉用户首屏输出。
    ws.emit({ type: 'output', data: BANNER + 'extra line\r\n' });
    let html = bufHtml(ctx.els);
    assert.ok(html.indexOf('extra line') >= 0, '三行形态必须完整展示');
    assert.ok(html.indexOf('Microsoft Windows') >= 0, '三行形态不得被当 banner 吞掉');

    const ctx2 = boot();
    const ws2 = openAndConnect(ctx2);
    ws2.emit({ type: 'output', data: 'Microsoft Windows [x]\r\n' });
    html = bufHtml(ctx2.els);
    assert.ok(html.indexOf('Microsoft Windows [x]') >= 0, '单行形态必须展示');
});

test('去重不得吞掉含 banner 字样的合法命令回显（负样本）', () => {
    const ctx = boot();
    const ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });

    // 回显以提示符开头、正文含「Microsoft Windows」：不是 banner，必须展示
    ws.emit({ type: 'output', data: 'C:\\w>type note.txt\r\nMicrosoft Windows inner line\r\n' });
    let html = bufHtml(ctx.els);
    assert.ok(html.indexOf('type note.txt') >= 0, '命令回显被去重误吞');
    assert.ok(html.indexOf('Microsoft Windows inner line') >= 0, '回显正文被去重误吞');

    // 形似 banner 但缺收尾换行（后端切片不会产出此形态）：必须展示
    ws.emit({ type: 'output', data: 'Microsoft Windows [x]\r\n(c) y' });
    html = bufHtml(ctx.els);
    assert.ok(html.indexOf('(c) y') >= 0, '非 banner 形态不得被丢弃');
});

test('restart 清屏后新连接的首帧 banner 应重新展示', () => {
    const ctx = boot();
    let ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1);

    ctx.els.codeTerminalRestartBtn.listeners.click[0]();
    const ws2 = ctx.sockets[ctx.sockets.length - 1];
    assert.notStrictEqual(ws2, ws, 'restart 必须重建连接');
    ws2.open();
    ws2.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1,
        '清屏后 banner 应重新展示一次（bannerSeen 须随清屏重置）');
});

test('清空按钮清屏后重连的 banner 亦应重新展示（与 restart 同语义）', () => {
    const ctx = boot();
    let ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1);

    ctx.els.codeTerminalClearBtn.listeners.click[0]();
    assert.equal(bufHtml(ctx.els).indexOf('Microsoft Windows'), -1, '清空应清掉缓冲');

    // 关面板 → 重开懒重连 → 后端按协议再补发首帧 banner
    ctx.sandbox.window.toggleCodeTerminal();
    ws = openAndConnect(ctx);
    ws.emit({ type: 'output', data: BANNER });
    assert.equal(countOf(bufHtml(ctx.els), 'Microsoft Windows'), 1,
        '清屏后重连补发的 banner 必须重新展示（不重置 bannerSeen 会被静默吞掉、屏顶缺横幅）');
});

// ---------- 形状双侧锁（声明侧 + 消费侧 + 重置侧） ----------

test('形状锁：bannerSeen 声明/首帧窗口消费/restart 与清空双重置', () => {
    assert.match(termJs, /restartToken: 0,\r?\n[\s\S]{0,600}?bannerSeen: false,/,
        'createTab 必须初始化 bannerSeen（缺省 false=首帧放行）');
    const msgAt = termJs.indexOf('socket.onmessage = function (ev) {');
    const onMsg = termJs.slice(msgAt);
    const winOpen = onMsg.indexOf('if (firstFrame) {');
    const dedupe = onMsg.indexOf('if (tab.bannerSeen) return;');
    const mark = onMsg.indexOf('tab.bannerSeen = true;');
    const append = onMsg.indexOf('appendOutputTo(tab, d);');
    assert.ok(winOpen >= 0, 'onmessage 必须有连接级首帧窗口（firstFrame）');
    assert.ok(dedupe > winOpen, '丢弃分支必须在首帧窗口内（窗口外命中=误吞用户输出）');
    assert.ok(mark > dedupe, '首展必须落标记');
    assert.ok(append > mark, '追加必须在判定之后');
    const declAt = termJs.indexOf('var firstFrame = true;');
    assert.ok(declAt >= 0 && declAt < msgAt,
        'firstFrame 必须是连接级变量（connectTab 内声明、每连接重置）');
    assert.match(termJs, /tab\.bufEl\.innerHTML = '';\r?\n\s*tab\.bannerSeen = false;/,
        'restart 清屏必须重置 bannerSeen');
    assert.match(termJs, /activeTab\.bufEl\.innerHTML = '';\r?\n[\s\S]{0,220}?activeTab\.bannerSeen = false;/,
        '清空按钮清屏必须同样重置 bannerSeen');
});

test('形状锁：isWindowsBanner 判据与后端切片严格同口径（版本行开头、恰两行、换行收尾）', () => {
    const at = termJs.indexOf('function isWindowsBanner(text) {');
    const body = termJs.slice(at, termJs.indexOf('\n    }', at));
    assert.match(body, /text\.indexOf\('Microsoft Windows'\) !== 0/,
        '必须以版本行开头（宽松 includes 会吞命令回显）');
    assert.match(body, /text\.charAt\(text\.length - 1\) !== '\\n'/,
        '必须以换行收尾（与后端 substring(0, idx2+1) 同口径）');
    assert.match(body, /secondNl === text\.length - 1/,
        '必须恰两行（后端切片止于第二个换行，三行形态永不产出）');
    assert.match(body, /secondNl > firstNl \+ 1/,
        '第二行必须非空（后端切片要求 idx2>idx+1）');
    assert.ok(termJs.indexOf('\uFFFD') < 0, '源文件不得含替换符');
});

// ---------- 镜像同步 ----------

test('gourd-ai-tauri/ui 与 desktop out 镜像与 static 源同步（存在镜像时才比对）', () => {
    const mirrors = [
        path.resolve(__dirname, '../../../../gourd-ai-tauri/ui/js/app-terminal.js'),
        path.resolve(__dirname, '../../../../gourd-ai-desktop/out/win-unpacked/resources/ui/js/app-terminal.js')
    ];
    for (const m of mirrors) {
        if (!fs.existsSync(m)) continue;
        assert.equal(fs.readFileSync(m, 'utf8'), termJs,
            '镜像不同步: ' + m + '（tauri 跑 node gourd-ai-tauri/cmd/prepare-ui.js；' +
            'desktop 跑其 prepare-resources 或重建安装包）');
    }
});
