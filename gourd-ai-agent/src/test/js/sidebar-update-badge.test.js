/**
 * 契约测试：桌面端侧边栏底部「更新」按钮（app-update-badge.js）。
 *
 * 背景：自动更新原先只在「设置→关于」有入口，启动 toast 一闪而过，常驻托盘的
 * 长跑进程等于没有提示。本按钮把 updater-state 快照映射为底栏常驻可操作建议。
 *
 * 覆盖：
 * - 纯函数 viewFor：七种 status × 三种 mode 的显隐/文案/角标/进度口径（表驱动，跑真实源码）
 * - downloadLabel / clampPercent：无 Content-Length（total=0）与百分比越界
 * - shouldShow：浏览器端（无 IPC）恒 false
 * - 真实 DOM 行为：挂载微型桩后驱动 render，断言 is-visible / data-state / 文案 /
 *   --gwork-update-pct / title，以及点击按状态分派 updaterDownload / updaterInstall
 * - 源码形态接线：按钮 DOM 在 index.html 底栏（必须排在 settingsBtn 之后，防设置
 *   随更新显隐跳位）、脚本已注册进 APP_SCRIPTS、CSS 默认隐藏 + 三种状态类 + 角标 + 进度条伪元素
 * - 12 语言包均提供 app.sidebar.update_* 五键，update_tooltip 含 {0}
 * - gourd-ai-tauri/ui 发布副本与 static 源同步（存在镜像时才比对）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const source = readStatic('js', 'app-update-badge.js');
const appCss = readStatic('css', 'app.css');
const indexHtml = readStatic('index.html');
const bootstrap = readStatic('js', 'app-bootstrap.js');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const UPDATE_KEYS = ['update_now', 'update_download', 'update_downloading', 'update_install',
    'update_tooltip', 'update_tooltip_downloading', 'update_tooltip_downloaded'];

/* 中文直译桩：断言文案即 key（等价于「取到了正确的 i18n 键」，且不依赖语言包内容） */
const dict = new Map([
    ['app.sidebar.update_now', '立即更新'],
    ['app.sidebar.update_download', '下载更新'],
    ['app.sidebar.update_downloading', '下载中…'],
    ['app.sidebar.update_install', '立即安装'],
    ['app.sidebar.update_tooltip', '发现新版本 {0}'],
    ['app.sidebar.update_tooltip_downloading', '新版本 {0} 正在下载'],
    ['app.sidebar.update_tooltip_downloaded', '新版本 {0} 已下载完成，点击安装并重启'],
]);
const GourdI18n = { t: (k, args) => (dict.get(k) || k).replace(/\{0\}/g, args && args.length ? String(args[0]) : '') };

/** 在 vm 沙箱中执行真实源码，返回其导出的纯函数与注册到的初始化钩子。 */
function createSandbox(opts) {
    opts = opts || {};
    const listeners = { dom: [], doc: {} };
    const calls = { updaterDownload: 0, updaterInstall: 0, onUpdaterState: 0, updaterGetState: 0 };

    function mkEl(tag) {
        const el = {
            tagName: tag.toUpperCase(), className: '', textContent: '', children: [],
            attrs: {}, styleProps: {}, handlers: {},
            classList: {
                add(c) { const s = new Set((el.className || '').split(/\s+/).filter(Boolean)); s.add(c); el.className = [...s].join(' '); },
                remove(c) { el.className = (el.className || '').split(/\s+/).filter(x => x && x !== c).join(' '); },
                contains(c) { return (el.className || '').split(/\s+/).indexOf(c) >= 0; },
            },
            setAttribute(k, v) { el.attrs[k] = String(v); },
            removeAttribute(k) { delete el.attrs[k]; },
            getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
            addEventListener(t, fn) { (el.handlers[t] = el.handlers[t] || []).push(fn); },
            appendChild(c) { el.children.push(c); return c; },
            querySelector(sel) {
                const cls = sel.replace(/^\./, '');
                return el.children.find(c => (c.className || '').split(/\s+/).indexOf(cls) >= 0) || null;
            },
        };
        el.style = {
            setProperty(k, v) { el.styleProps[k] = v; },
            removeProperty(k) { delete el.styleProps[k]; },
        };
        return el;
    }

    const btn = mkEl('button');
    btn.id = 'sidebarUpdateBtn';
    const label = mkEl('span');
    label.className = 'sidebar-update-btn-label';
    btn.appendChild(label);
    btn.appendChild(mkEl('span')).className = 'sidebar-update-dot';

    const document = {
        readyState: opts.readyState || 'complete',
        getElementById(id) { return id === 'sidebarUpdateBtn' ? btn : null; },
        addEventListener(type, fn) { (document.docHandlers[type] = document.docHandlers[type] || []).push(fn); },
        docHandlers: {},
    };

    const ipc = {
        isDesktop: !!opts.isDesktop,
        updaterDownload() { calls.updaterDownload++; return Promise.resolve(opts.nextState || null); },
        updaterInstall() { calls.updaterInstall++; return Promise.resolve(opts.nextState || null); },
        onUpdaterState(cb) { calls.onUpdaterState++; listeners.dom.push(cb); },
        updaterGetState() { calls.updaterGetState++; return Promise.resolve(opts.initialState || null); },
    };

    // 单一沙箱：window 与 document 均为全局词法成员，源码只执行一次
    // （跑两遍会重复注册监听、覆盖 __gworkUpdateBadgeApi，断言全部失真）。
    const sandbox = { document, GourdI18n, console };
    sandbox.window = sandbox;
    if (opts.isDesktop) sandbox.__GOURD_IPC__ = ipc;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'app-update-badge.js' });

    const api = sandbox.__gworkUpdateBadgeApi;
    return { api, calls, listeners, btn, label, document, window: sandbox, ipc };
}

/* 纯函数沙箱：getElementById 返回 null 使挂载早退，只取导出的纯函数。 */
function pureApi(isDesktop) {
    const sandbox = {
        document: {
            readyState: 'loading',
            getElementById() { return null; },
            addEventListener() {},
            docHandlers: {},
        },
        GourdI18n,
        console,
    };
    sandbox.window = sandbox;
    if (isDesktop) {
        sandbox.__GOURD_IPC__ = {
            isDesktop: true,
            onUpdaterState() {},
            updaterGetState() { return Promise.resolve(null); },
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'app-update-badge.js' });
    return sandbox.__gworkUpdateBadgeApi;
}

/* ── 纯函数：状态映射表 ─────────────────────────────────────────────────── */

/** 冲刷 IPC 回调的 promise 链（updaterGetState().then(render) 是异步微任务）。 */
function flush(times) {
    let p = Promise.resolve();
    for (let i = 0; i < (times || 6); i++) p = p.then(() => new Promise(r => setImmediate(r)));
    return p;
}

test('viewFor：仅 available / downloading / downloaded 显示，且逐态口径正确', () => {
    const api = pureApi(true);

    // 不显示的状态
    for (const status of ['idle', 'checking', 'not-available', 'error']) {
        assert.equal(api.viewFor({ mode: 'auto', status }), null, status + ' 不得显示按钮');
    }
    assert.equal(api.viewFor(null), null, '空快照不得显示');
    assert.equal(api.viewFor({ mode: 'none', status: 'available' }), null, '开发态 mode=none 一律不显示');
    assert.equal(api.viewFor({ status: 'available' }), null, '缺 mode 视为不可用');

    // available：auto 用「立即更新」，notify 用「下载更新」，两者都带红点
    const autoAvail = api.viewFor({ mode: 'auto', status: 'available', version: '0.2.0' });
    assert.equal(autoAvail.state, 'available');
    assert.equal(autoAvail.label, '立即更新');
    assert.equal(autoAvail.showDot, true);
    assert.equal(autoAvail.percent, null);

    const notifyAvail = api.viewFor({ mode: 'notify', status: 'available', version: '0.2.0' });
    assert.equal(notifyAvail.label, '下载更新', 'notify 模式点击是打开下载页，动词必须是下载');

    // downloaded：文案「立即安装」，红点让位给强调色底色
    const dl = api.viewFor({ mode: 'auto', status: 'downloaded', version: '0.2.0' });
    assert.equal(dl.state, 'downloaded');
    assert.equal(dl.label, '立即安装');
    assert.equal(dl.showDot, false);
});

test('tooltip 按状态分派：三个状态各用专属 key，且均带版本号', () => {
    const api = pureApi(true);
    assert.equal(api.viewFor({ mode: 'auto', status: 'available', version: '0.2.0' }).tipKey, 'app.sidebar.update_tooltip');
    assert.equal(api.viewFor({ mode: 'auto', status: 'downloading', version: '0.2.0', progress: { percent: 1, total: 9 } }).tipKey,
        'app.sidebar.update_tooltip_downloading');
    assert.equal(api.viewFor({ mode: 'auto', status: 'downloaded', version: '0.2.0' }).tipKey,
        'app.sidebar.update_tooltip_downloaded');
    for (const s of ['available', 'downloaded']) {
        const v = api.viewFor({ mode: 'auto', status: s, version: '9.9.9' });
        // 逐项比对而非 deepEqual：沙箱里产出的数组原型是 vm context 的 Array，
        // assert/strict 的 deepEqual 会因原型不同而报“看起来完全一样”的错
        assert.equal(v.tipArgs.length, 1, s + ' 的 tooltip 参数必须只有一个版本号');
        assert.equal(v.tipArgs[0], '9.9.9', s + ' 的 tooltip 必须带版本号');
    }
});

test('viewFor(downloading)：有总大小才产出百分比，无 Content-Length 退回无数字文案', () => {
    const api = pureApi(true);
    const withTotal = api.viewFor({
        mode: 'auto', status: 'downloading', version: '0.2.0',
        progress: { percent: 42, total: 100, transferred: 42 },
    });
    assert.equal(withTotal.state, 'downloading');
    // 文案是纯百分比（数字语言中立）：多语言下「Wird heruntergeladen… 42.5%」这类
    // 长词组会撞爆 280px 侧栏底栏，完整说明已移到 tooltip
    assert.equal(withTotal.label, '42.0%');
    assert.equal(withTotal.percent, 42);
    assert.equal(withTotal.showDot, true);

    // total=0 是后端「响应无 Content-Length」的真实取值（此时 percent 恒 0），
    // 若仍渲染数字会显示「0.0%」的假静止 → 必须退回不带数字的短词
    const noTotal = api.viewFor({
        mode: 'auto', status: 'downloading', version: '0.2.0',
        progress: { percent: 0, total: 0, transferred: 1024 },
    });
    assert.equal(noTotal.label, '下载中…');
    assert.equal(noTotal.percent, null, '无总大小时不得产出 percent，避免把 0% 画成静止');

    const noProgress = api.viewFor({ mode: 'auto', status: 'downloading' });
    assert.equal(noProgress.percent, null);
    assert.equal(noProgress.label, '下载中…');
});

test('clampPercent：越界与非数值一律夹到 0~100', () => {
    const api = pureApi(true);
    assert.equal(api.clampPercent(0), 0);
    assert.equal(api.clampPercent(100), 100);
    assert.equal(api.clampPercent(137.5), 100, '后端百分比异常偏高不得撑破进度条');
    assert.equal(api.clampPercent(-5), 0);
    assert.equal(api.clampPercent(undefined), 0, '缺字段不得产出 NaN');
    assert.equal(api.clampPercent(NaN), 0);
    assert.ok(!isFinite(api.clampPercent('abc')) === false, '非数值必须归零');
});

test('shouldShow：浏览器端（无 IPC）恒 false', () => {
    const web = pureApi(false);
    assert.equal(web.shouldShow({ mode: 'auto', status: 'available' }), false,
        '浏览器端没有更新通道，任何状态都不该显示');
    const desk = pureApi(true);
    assert.equal(desk.shouldShow({ mode: 'auto', status: 'available' }), true);
    assert.equal(desk.shouldShow({ mode: 'auto', status: 'idle' }), false);
});

/* ── 真实 DOM 行为 ──────────────────────────────────────────────────────── */

test('渲染：available 显示按钮、写 data-state/文案/title；转 not-available 后整体收起', async () => {
    const h = createSandbox({ isDesktop: true, initialState: { mode: 'auto', status: 'available', version: '0.2.0' } });
    const ui = h.api._ui();
    assert.ok(ui, '桌面端必须完成挂载');
    await flush();

    assert.ok(h.btn.classList.contains('is-visible'), '检测到新版必须可见');
    assert.equal(h.btn.getAttribute('data-state'), 'available');
    assert.equal(h.label.textContent, '立即更新');
    assert.equal(h.btn.getAttribute('title'), '发现新版本 0.2.0', 'title 必须带版本号，与 tooltip 契约一致');
    // 状态回退（复检发现已升级/无新版）→ 收起并清理，不留残余文案与进度变量
    ui.render({ mode: 'auto', status: 'not-available' });
    assert.equal(h.btn.classList.contains('is-visible'), false);
    assert.equal(h.btn.getAttribute('data-state'), null);
    assert.equal(h.label.textContent, '');
    assert.equal(h.btn.styleProps['--gwork-update-pct'], undefined);
});

test('渲染：downloading 就地写百分比到 --gwork-update-pct 与文案；无总大小不写宽度', async () => {
    const h = createSandbox({ isDesktop: true });
    const ui = h.api._ui();
    await flush();
    ui.render({ mode: 'auto', status: 'downloading', version: '0.2.0', progress: { percent: 42.5, total: 100, transferred: 42 } });
    assert.equal(h.btn.getAttribute('data-state'), 'downloading');
    assert.equal(h.btn.styleProps['--gwork-update-pct'], '42.5%', 'CSS 变量宽度必须与百分比同步');
    assert.equal(h.label.textContent, '42.5%');
    assert.equal(h.btn.getAttribute('title'), '新版本 0.2.0 正在下载', '下载中 title 走专属文案');

    ui.render({ mode: 'auto', status: 'downloading', version: '0.2.0', progress: { percent: 0, total: 0, transferred: 4096 } });
    assert.equal(h.btn.styleProps['--gwork-update-pct'], undefined, 'total=0 不得写入宽度，否则进度线恒 0 像卡死');
    assert.equal(h.label.textContent, '下载中…');
});

test('点击：available→updaterDownload，downloaded→updaterInstall，收起后点击零副作用', async () => {
    const h = createSandbox({ isDesktop: true, initialState: { mode: 'auto', status: 'available', version: '0.2.0' } });
    await flush();
    h.btn.handlers.click[0]();
    assert.equal(h.calls.updaterDownload, 1, 'available 点击必须触发下载/引导下载');
    assert.equal(h.calls.updaterInstall, 0);

    h.api._ui().render({ mode: 'auto', status: 'downloaded', version: '0.2.0' });
    h.btn.handlers.click[0]();
    assert.equal(h.calls.updaterInstall, 1, 'downloaded 点击必须安装并重启');
    assert.equal(h.calls.updaterDownload, 1, 'downloaded 不得再触发下载');

    h.api._ui().render({ mode: 'auto', status: 'idle' });
    h.btn.handlers.click[0]();
    await flush();
    assert.equal(h.calls.updaterDownload, 1);
    assert.equal(h.calls.updaterInstall, 1, '收起状态下无视图可动作');
});

test('事件订阅：注册 onUpdaterState 且主动拉一次快照（覆盖事件早于加载的竞态）', async () => {
    const h = createSandbox({ isDesktop: true, initialState: { mode: 'auto', status: 'downloaded', version: '0.3.0' } });
    assert.equal(h.calls.onUpdaterState, 1, '必须且只注册一次事件监听');
    assert.equal(h.calls.updaterGetState, 1, '必须兜底主动拉快照');
    await flush();
    assert.equal(h.label.textContent, '立即安装');
});

test('事件驱动：onUpdaterState 注册的回调即渲染入口，广播新快照即更新按钮', async () => {
    /* 审查补强：原用例只走「updaterGetState 主动拉取」与手动 ui.render 两条通道，
       从未验证 onUpdaterState 注册进去的那个回调真的接到 ui.render —— 若注册成
       空函数（变异脚本 M15），后台广播的新版永远不会点亮按钮，而旧用例全绿。 */
    const h = createSandbox({ isDesktop: true });
    await flush();
    assert.equal(h.btn.classList.contains('is-visible'), false, '初始无快照不得显示');
    assert.equal(h.listeners.dom.length, 1, '必须恰好注册一个 updater-state 回调');
    h.listeners.dom[0]({ mode: 'auto', status: 'available', version: '0.4.0' });
    assert.ok(h.btn.classList.contains('is-visible'), '广播 available 后必须点亮');
    assert.equal(h.btn.getAttribute('data-state'), 'available');
    assert.equal(h.label.textContent, '立即更新');
    assert.equal(h.btn.getAttribute('title'), '发现新版本 0.4.0');
    h.listeners.dom[0]({ mode: 'auto', status: 'downloaded', version: '0.4.0' });
    assert.equal(h.btn.getAttribute('data-state'), 'downloaded', '广播 downloaded 后须切到安装态');
    assert.equal(h.label.textContent, '立即安装');
});

test('语言切换：按上一次快照重渲染，文案与 title 随 locale 更新且不丢状态', async () => {
    const h = createSandbox({ isDesktop: true, initialState: { mode: 'auto', status: 'available', version: '0.2.0' } });
    await flush();
    const handlers = h.document.docHandlers['i18n:localeChanged'] || [];
    assert.ok(handlers.length >= 1, '必须监听 i18n:localeChanged');
    const oriNow = dict.get('app.sidebar.update_now');
    const oriTip = dict.get('app.sidebar.update_tooltip');
    try {
        dict.set('app.sidebar.update_now', 'Update now');
        dict.set('app.sidebar.update_tooltip', 'Update available: {0}');
        handlers.forEach(fn => fn());
        assert.equal(h.label.textContent, 'Update now', '切语言后按钮文案必须刷新');
        assert.equal(h.btn.getAttribute('title'), 'Update available: 0.2.0', '切语言后 title 也必须刷新');
    } finally {
        // 本文件各用例共享同一份 dict，改完必须复原，否则顺序耦合
        dict.set('app.sidebar.update_now', oriNow);
        dict.set('app.sidebar.update_tooltip', oriTip);
    }
    assert.equal(h.btn.getAttribute('data-state'), 'available', '重渲染不得丢状态');
});

test('浏览器端：完全不注册监听、不显示', () => {
    const h = createSandbox({ isDesktop: false });
    assert.equal(h.api._ui(), null, '无 IPC 时不得挂载');
    assert.equal(h.calls.onUpdaterState, 0);
    assert.equal(h.btn.classList.contains('is-visible'), false);
});

/* ── 源码形态接线护栏（防「改了逻辑没接线」这一类静默失效）─────────────── */

test('index.html：底栏含更新按钮，默认不带 is-visible（无新版时不占位）', () => {
    assert.match(indexHtml, /<button class="sidebar-update-btn" id="sidebarUpdateBtn"[^>]*data-state="idle">/);
    assert.match(indexHtml, /class="sidebar-update-btn-label" id="sidebarUpdateLabel"/);
    assert.match(indexHtml, /class="sidebar-update-dot"/);
    assert.ok(!/sidebar-update-btn[^"]*is-visible/.test(indexHtml),
        '静态骨架不得预设 is-visible，否则无新版时会显示空按钮');
    const footer = indexHtml.slice(indexHtml.indexOf('class="sidebar-footer"'));
    /* 【顺序纪律】必须是「设置在前、更新在后」：底栏是 justify-content:space-between，
       首子项恒贴左端、末子项贴右端。设置做首子项 → 位置不随有无更新跳变（真浏览器
       实测过反序：设置会在无更新时 x=14、有更新时瞬移到 x=201）；更新做末子项 →
       有新版时靠右出现，不与设置挤位。顺序被调换时本断言必须变红。 */
    assert.ok(footer.indexOf('id="settingsBtn"') < footer.indexOf('sidebarUpdateBtn'),
        '设置按钮必须排在更新按钮之前（防设置随更新显隐左右跳位）');
});

test('app-bootstrap：更新按钮脚本已注册进 APP_SCRIPTS', () => {
    assert.match(bootstrap, /'\/js\/app-update-badge\.js'/);
    const i = bootstrap.indexOf("'/js/app-settings-about.js'");
    const j = bootstrap.indexOf("'/js/app-update-badge.js'");
    assert.ok(i >= 0 && j > i, '放在 app-settings-about 之后，与更新状态机同区');
});

test('app.css：默认隐藏 + 显现 + 三态样式 + 角标 + 就地进度条齐备', () => {
    // 默认 display:none 是「无新版不占位」的唯一保证
    assert.match(appCss, /\.sidebar-update-btn \{[^}]*display: none/);
    assert.match(appCss, /\.sidebar-update-btn\.is-visible \{[^}]*display: flex/);
    assert.match(appCss, /\.sidebar-update-btn\[data-state="downloaded"\] \{[^}]*background: var\(--accent\)/);
    assert.match(appCss, /\.sidebar-update-btn\[data-state="downloaded"\][^}]*color: var\(--accent-contrast\)/);
    assert.match(appCss, /\.sidebar-update-dot \{[^}]*border-radius: 50%[^}]*\}/);
    assert.match(appCss, /\.sidebar-update-btn\[data-state="downloading"\]::after \{[^}]*width: var\(--gwork-update-pct/);
    // 动效必须可被系统「减少动态」偏好关掉
    assert.match(appCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.sidebar-update-dot \{ animation: none/);
});

test('app.css 尺寸护栏：截断只能发生在 label 上，且不得挤坏底栏常驻项', () => {
    /* 浏览器实测过的两条回归（都是“看一眼就会发现”的观感问题，但单测/静态阅读极易漏）：
       1) 按钮自带 overflow:hidden 会裁掉 top/right 负偏移的红点；
       2) flex-shrink:0 + nowrap 的长文案（德/俄）会撑高底栏、挤得设置按钮文字换行。 */
    const rule = appCss.match(/\.sidebar-update-btn \{([^}]*)\}/)[1];
    assert.ok(!/overflow:\s*hidden/.test(rule), '按钮不得 overflow:hidden，否则红点角标会被裁掉');
    assert.ok(/flex:\s*0 1 auto/.test(rule), '按钮必须允许收缩，长文案不得撑破底栏');
    assert.ok(/min-width:\s*0/.test(rule), '缺 min-width:0 则 flex 子项不会收缩到内容宽以下');
    assert.match(appCss, /\.sidebar-update-btn-label \{[^}]*text-overflow: ellipsis/);
    // 设置按钮是底栏常驻项，不得被更新按钮挤压换行/撑高
    assert.match(appCss, /\.sidebar-footer \.settings-btn \{[^}]*flex-shrink: 0/);
    assert.match(appCss, /\.sidebar-footer \.settings-btn \{[^}]*white-space: nowrap/);
});

test('app.css 极窄兜底：底栏声明容器查询，空间不足时退图标态而不截断百分比', () => {
    /* 真浏览器实测：侧栏拖窄后连「42.5%」都会被省略号截成「4…」，进度信息直接
       失效，比不显示更坏。改用容器查询整块收起文字：红点 + 底边进度条 + 强调色
       仍传达完整状态，百分比降级到 title。 */
    assert.match(appCss, /\.sidebar-footer \{[^}]*container-type: inline-size/);
    const q = appCss.match(/@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/);
    assert.ok(q, '缺少 @container 兜底规则块');
    const threshold = Number(q[1]);
    assert.match(q[2], /\.sidebar-update-btn \.sidebar-update-btn-label \{[^}]*display: none/);

    /* 阈值必须由「底栏内容宽」标定（.tmp/calibrate_container_threshold.js 实测），
       而不是拍个比默认宽还大的数——那会让平时也丢文字。 */
    const base = Number(appCss.match(/--sidebar-width:\s*(\d+)px/)[1]);
    const pad = Number(appCss.match(/\.sidebar-footer \{[^}]*padding: 12px (\d+)px/)[1]);
    const defaultContent = base - 1 - pad * 2;            // 280 侧栏 - 1 边框 - 28 内边距
    const minContent = 180 - 1 - pad * 2;                 // app-ui.js SIDEBAR_MIN_WIDTH = 180
    assert.ok(threshold < defaultContent,
        '阈值 ' + threshold + ' 不得 ≥ 默认底栏内容宽 ' + defaultContent + '，否则默认宽度下就丢文字');
    assert.ok(threshold > minContent,
        '阈值 ' + threshold + ' 应高于最窄可用宽 ' + minContent + '，否则兜底永不触发');
    /* 实测安全边界（.tmp/probe_de_band.js）：侧栏 264px→content 235px 时最长文案仍未截断。
       阈值应紧贴这个边界下方：高于它就白设（仍会先截断），远低于它就过早退图标。 */
    const SAFE_TEXT_CONTENT = 235;
    assert.ok(threshold >= SAFE_TEXT_CONTENT - 8 && threshold < SAFE_TEXT_CONTENT,
        '阈值 ' + threshold + ' 应紧贴实测安全宽 ' + SAFE_TEXT_CONTENT + ' 下方（±8px 内），');
});

/* ── 语言包与发布副本 ───────────────────────────────────────────────────── */

test('12 个语言包均提供 app.sidebar.update_* 七键且三个 tooltip 含 {0}', () => {
    for (const lang of LOCALES) {
        const data = JSON.parse(readStatic('locales', lang + '.json'));
        assert.ok(data.app && data.app.sidebar, lang + ' 缺少 app.sidebar 段');
        for (const key of UPDATE_KEYS) {
            const v = data.app.sidebar[key];
            assert.ok(typeof v === 'string' && v.trim().length > 0, lang + ' 缺少 app.sidebar.' + key);
            assert.ok(v === v.trim(), lang + '.' + key + ' 不得带首尾空白');
        }
        for (const key of ['update_tooltip', 'update_tooltip_downloading', 'update_tooltip_downloaded']) {
            assert.ok(data.app.sidebar[key].indexOf('{0}') >= 0,
                lang + ' ' + key + ' 必须保留 {0} 版本号占位符');
        }
        // 底栏可用宽度有限（默认 280px，可拖窄到 200px）：按钮文案必须短，长说明交给 tooltip
        for (const key of ['update_now', 'update_download', 'update_downloading', 'update_install']) {
            const v = data.app.sidebar[key];
            assert.ok(v.length <= 18, lang + '.' + key + ' 过长（' + v.length + ' 字符）会撞爆底栏: ' + v);
        }
    }
});

test('gourd-ai-tauri/ui 发布副本与 static 源保持同步', () => {
    /* 路径基准必须是四级（test/js → 仓库根），少一级会拼出不存在的路径并配合
       existsSync 早退造出恒空跑的假绿灯（本仓库踩过）。镜像被 .gitignore 忽略，
       CI 干净检出时不存在 → 保留「不在则跳过」。 */
    const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) return;
    const files = [['index.html'], ['css', 'app.css'], ['js', 'app-update-badge.js'], ['js', 'app-bootstrap.js']];
    for (const parts of files) {
        const src = readStatic(...parts);
        const mirror = fs.readFileSync(path.join(mirrorRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请重跑 prepare-ui: ' + parts.join('/'));
    }
    for (const lang of LOCALES) {
        const rel = path.join('locales', lang + '.json');
        const src = readStatic(rel);
        const mirror = fs.readFileSync(path.join(mirrorRoot, rel), 'utf8').replace(/^\uFEFF/, '');
        assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请重跑 prepare-ui: ' + rel);
    }
});
