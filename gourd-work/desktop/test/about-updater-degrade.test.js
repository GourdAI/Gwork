/* 关于页「检查更新」卡片：外壳无 updater 能力时必须诚实降级
 *
 * 缺陷机制（本次实测确认，非推理）：
 * Rust 原生壳不含 tauri-plugin-updater，ipc_bridge.rs 刻意不暴露 updater* 方法。
 * 而 app-settings-about.js 的 applyState 只区分三种情况：
 *   !isDesktop → web_mode 文案 / mode==='none' → dev_mode 文案 / 其余按状态机渲染。
 * 「isDesktop 为真但外壳根本没有 updater 能力」这个组合前端从未预期：load() 里
 * `typeof ipc.updaterGetState === 'function'` 为假 → 永不拉快照 → lastState 恒 null
 * → 落进那个为「快照在途」设计的瞬态占位分支（一个省略号）并永久停在那里。
 * 用户看到的是一张空白的「检查更新」卡片，没有按钮，也没有任何解释。
 *
 * 现在的契约：缺能力就直说「此版本不支持应用内更新」并给出官网下载入口；
 * 且骨架首屏文案不得写「正在检查更新…」（否则先闪一帧假进行中态）。
 * 能力齐备时行为一字不变 —— 用同一份源码跑两种桥接做对照，避免「修好了降级、
 * 顺手弄坏了正常路径」这类只在装了新版才暴露的回归。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI = path.join(__dirname, '..', 'ui');
const SRC = fs.readFileSync(path.join(UI, 'js', 'app-settings-about.js'), 'utf8');
const LOCALES = path.join(UI, 'locales');
const ZH = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN.json'), 'utf8'));

function translate(dict, key, args) {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), dict);
    let s = (typeof v === 'string') ? v : key;
    if (args) args.forEach((a, i) => { s = s.split('{' + i + '}').join(a); });
    return s;
}

/* 最小 jQuery / DOM 桩：只覆盖本模块真正用到的调用面。
   $('#aboutUpdateArea').html(x) 的写入被记进 htmlOf，供断言读回。 */
function makeEnv(ipc) {
    const htmlOf = {};
    const handlers = {};
    const $ = function (sel) {
        if (sel === env.document) return { on: (ev, s, cb) => { handlers[s] = cb; } };
        const key = String(sel);
        return {
            length: 1,
            html(h) { if (h === undefined) return htmlOf[key] || ''; htmlOf[key] = h; return this; },
            on(ev, s, cb) { handlers[s] = cb; },
            prop() { return this; },
        };
    };
    const document = {
        readyState: 'complete',
        getElementById: () => ({ textContent: '' }),
        addEventListener() {},
    };
    const env = { htmlOf, handlers, document };
    const win = {
        GourdI18n: { t: (k, a) => translate(ZH, k, a) },
        __GOURD_IPC__: ipc,
        showToast() {},
        document,
    };
    win.window = win;
    env.ctx = vm.createContext(Object.assign(win, { $, document, console, setTimeout, Promise }));
    return env;
}

/* 真实 Rust 壳桥接：ipc_bridge.rs 的 __GOURD_IPC__ 字面量里没有任何 updater* 方法。
   其余方法按该文件实际暴露的集合给，避免用一个不存在的形态测出不存在的结论。 */
function rustBridge() {
    return {
        isDesktop: true,
        platform: 'win32',
        getAppVersion: () => Promise.resolve('0.3.0'),
        setWindowTitle() {},
        pickDirectory() {},
        pickFile() {},
    };
}

/* 能力齐备的桥接（旧 Tauri 壳形态），用于证明正常路径未被这次改动波及。 */
function updaterBridge(snapshot) {
    const snap = Object.assign({
        mode: 'auto', status: 'not-available', version: null, currentVersion: '0.3.0',
        releaseNotes: '', downloadUrl: '', progress: null, error: '',
    }, snapshot || {});
    return Object.assign(rustBridge(), {
        updaterGetState: () => Promise.resolve(snap),
        updaterCheck: () => Promise.resolve(snap),
        updaterDownload: () => Promise.resolve(snap),
        updaterInstall: () => Promise.resolve(snap),
        onUpdaterState() {},
    });
}

async function renderAbout(ipc) {
    const env = makeEnv(ipc);
    vm.runInContext(SRC, env.ctx);
    env.ctx._settingsAbout.load();
    await new Promise(r => setTimeout(r, 20));
    return {
        area: env.htmlOf['#aboutUpdateArea'] || '',
        skeleton: env.htmlOf['#settingsTabAbout'] || '',
    };
}

const NO_UPDATER = ZH.settings.about.no_updater;
const OPEN_PAGE = ZH.settings.about.open_download_page;
const CHECKING = ZH.settings.about.checking;

test('无 updater 能力 → 卡片给出原因，而不是停在省略号', async () => {
    const { area } = await renderAbout(rustBridge());
    assert.ok(area.includes(NO_UPDATER), '应出现「不支持应用内更新」文案，实际: ' + area);
    assert.ok(!/>…</.test(area), '不得停在瞬态占位的省略号，实际: ' + area);
});

test('无 updater 能力 → 给出可点的官网下载入口（真链接，交系统浏览器）', async () => {
    const { area } = await renderAbout(rustBridge());
    assert.ok(area.includes(OPEN_PAGE), '应出现下载入口文案');
    assert.match(area, /<a[^>]+href="https:\/\/www\.gourdwork\.com\/"/, '应是指向官网的 <a>');
    assert.match(area, /target="_blank"/, '需 _blank 以请求新窗口（真正交给系统浏览器的是壳层拦截器，见下一条）');
    assert.match(area, /rel="noopener"/, '外链必须带 noopener');
});

/* 承重件在壳层，不在这个 _blank 属性上。
   wry 0.53 起 Windows 默认禁用新窗口创建：未注册 on_new_window 时 WebView2 直接
   SetHandled(true)，点击静默无反应。所以只断言 _blank 存在是不够的 —— 那正是上一轮
   把「死链」误判为「已工作」的原因。这里直接钉壳层：拦截器必须接在 builder 上，
   且外链必须经 scheme 守卫（否则被取消的 file:// 会被系统按文件关联程序打开）。 */
test('壳层必须接 on_new_window/on_navigation，否则 _blank 是死链', () => {
    const lib = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(lib, /\.on_new_window\(/, 'builder 未接 on_new_window：target="_blank" 会静默无反应');
    assert.match(lib, /\.on_navigation\(/, 'builder 未接 on_navigation：同窗跳转外链不会交给系统浏览器');
    assert.match(lib, /mod external_link;/, '未声明 external_link 模块');
    // 两个回调都必须经 is_internal_url 判定，而不是无条件放行/无条件外开
    const internalChecks = (lib.match(/external_link::is_internal_url\(/g) || []).length;
    assert.strictEqual(internalChecks, 2,
        '应恰好两处来源校验（on_new_window + on_navigation），实际 ' + internalChecks);

    const ext = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'external_link.rs'), 'utf8');
    assert.match(ext, /matches!\(url\.scheme\(\),\s*"http"\s*\|\s*"https"\)/,
        'scheme 守卫必须只放行 http(s)：被取消的 file:// 会走到 open_external');
    assert.match(ext, /if !is_external_openable\(url\)/,
        'open_external 必须先过 scheme 守卫再 spawn');
});

test('无 updater 能力 → 骨架首屏不得写「正在检查更新…」（否则闪一帧假进行中态）', async () => {
    const { skeleton } = await renderAbout(rustBridge());
    assert.ok(!skeleton.includes(CHECKING),
        '骨架不应出现 checking 文案，实际片段: ' + (skeleton.match(/aboutUpdateArea[\s\S]{0,120}/) || [''])[0]);
    assert.ok(skeleton.includes(NO_UPDATER), '骨架首屏应直接是降级文案');
});

test('能力齐备 → 正常路径不受影响，仍渲染状态与「检查更新」按钮', async () => {
    const { area, skeleton } = await renderAbout(updaterBridge());
    assert.ok(area.includes(ZH.settings.about.up_to_date), '应渲染 not-available 的真实状态');
    assert.match(area, /<button[^>]+id="aboutCheckBtn"/, '应保留手动检查按钮');
    assert.ok(!area.includes(NO_UPDATER), '能力齐备时不得出现降级文案');
    assert.ok(skeleton.includes(CHECKING), '能力齐备时骨架仍用 checking 占位');
});

test('能力齐备且发现新版 → 走 available 分支，不被降级分支截断', async () => {
    const { area } = await renderAbout(updaterBridge({ status: 'available', version: '0.4.0' }));
    assert.ok(area.includes('0.4.0'), '应带出新版本号，实际: ' + area);
    assert.ok(!area.includes(NO_UPDATER), '不得出现降级文案');
});

/* 半残桥接：只有 updaterGetState、没有 updaterCheck。
   此时若判为「有能力」，卡片会渲染出一个点下去毫无反应的「检查更新」按钮 ——
   比空白更糟（用户以为自己已经检查过了）。故要求 fail-closed 到降级分支。 */
test('桥接只实现一半（无 updaterCheck）→ fail-closed 降级，不给死按钮', async () => {
    const half = updaterBridge();
    delete half.updaterCheck;
    const { area } = await renderAbout(half);
    assert.ok(area.includes(NO_UPDATER), '应降级，实际: ' + area);
    assert.ok(!/id="aboutCheckBtn"/.test(area), '不得渲染无法工作的检查按钮');
});

test('浏览器端（非桌面）仍走 web_mode 文案，不被降级分支抢走', async () => {
    const { area } = await renderAbout({ isDesktop: false });
    assert.ok(area.includes(ZH.settings.about.web_mode), '实际: ' + area);
    assert.ok(!area.includes(NO_UPDATER), 'web 场景不应复用桌面降级文案');
});

/* 两侧 UI 副本的语言包必须同时有这两个键。
   static（Java 内核）与 desktop/ui（Rust 壳）是两份真实被消费的副本；本主题最初只改了
   desktop/ui 单侧，而两侧当时逐字节一致。降级分支对 Java 消费方虽恒不命中（Electron
   preload 与旧 Tauri 壳都暴露 updater*，已实测），但键缺失仍会在下次整体同步时把
   修复冲掉，故直接把「两侧都有」钉成契约。 */
test('static 侧语言包同步这两个键（否则下次镜像同步会冲掉修复）', () => {
    const staticLocales = path.resolve(__dirname, '..', '..', '..',
        'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');
    if (!fs.existsSync(staticLocales)) return; // 单仓检出（无 Java 模块）：显式跳过
    const langs = fs.readdirSync(staticLocales).filter(f => f.endsWith('.json'));
    assert.ok(langs.length >= 12, '自证：static 语言包只找到 ' + langs.length + ' 个，路径可能错了');
    const missing = [];
    for (const f of langs) {
        const j = JSON.parse(fs.readFileSync(path.join(staticLocales, f), 'utf8'));
        const ab = (j.settings || {}).about || {};
        ['no_updater', 'open_download_page'].forEach(k => {
            if (typeof ab[k] !== 'string' || !ab[k].trim()) missing.push(f + ':' + k);
        });
    }
    assert.deepStrictEqual(missing, [], 'static 侧缺失: ' + missing.join(', '));
});

test('12 个语言包都必须有这两个键（缺一个就会在该语言下露出键名）', () => {
    const langs = fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'));
    assert.strictEqual(langs.length, 12, '语言包数量变化，请同步本断言');
    const missing = [];
    for (const f of langs) {
        const j = JSON.parse(fs.readFileSync(path.join(LOCALES, f), 'utf8'));
        const ab = (j.settings || {}).about || {};
        ['no_updater', 'open_download_page'].forEach(k => {
            if (typeof ab[k] !== 'string' || !ab[k].trim()) missing.push(f + ':' + k);
        });
    }
    assert.deepStrictEqual(missing, [], '缺失: ' + missing.join(', '));
});

/* 官网地址必须单一出处：曾经 href 与显示文本各写一遍字面量，
   换域名时极易只改一处，而「显示 A 实际跳 B」的链接比坏链接更危险。 */
test('官网地址只有一个 URL 字面量（href 复用常量）', () => {
    const urls = SRC.match(/https:\/\/www\.gourdwork\.com\//g) || [];
    assert.strictEqual(urls.length, 1, '发现 ' + urls.length + ' 处 URL 字面量，应只有 HOMEPAGE_URL 常量');
    assert.match(SRC, /var HOMEPAGE_URL = 'https:\/\/www\.gourdwork\.com\/';/);
});

/* 顺序承重：降级判定必须在「快照尚未到达」之前。
   两者调换后，无能力场景会先命中省略号分支并 return，降级文案永远不可达 ——
   而那条 return 不会报错、测试若只看最终文案也可能被别的分支蒙过去，故直接钉位置。 */
test('applyState 中降级判定必须排在 !lastState 占位分支之前', () => {
    const iDegrade = SRC.indexOf('if (!hasUpdaterBridge())');
    const iPlaceholder = SRC.indexOf('if (!lastState)');
    assert.ok(iDegrade > 0, '未找到降级判定');
    assert.ok(iPlaceholder > 0, '未找到占位分支');
    assert.ok(iDegrade < iPlaceholder,
        '降级判定排在了占位分支之后，无能力场景会永久停在省略号');
});
