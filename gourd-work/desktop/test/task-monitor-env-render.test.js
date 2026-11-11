/**
 * 任务监控「环境信息」区【运行时行为】验证 —— 与 task-monitor-env-contract.test.js 互补。
 *
 * 【为什么必须真跑源码，而不是再加几条正则】
 * contract 那份只能锁住「源码里不得再出现 (status.changed || 0) 这类写法」，它证明不了
 * renderEnv 被调用后 DOM 里到底长什么样。本仓已多次踩到这个自欺陷阱
 * （account-entry-behavior.test.js 开头即注明「只靠源码字符串断言防不住这类回归，
 * 故用 vm 真实跑源码」）。本次用户报障的两个缺陷恰恰都是【渲染结果】缺陷：
 *   ① 有变更却一直显示「无变更」（数组被当数字相加，> 0 恒 false）；
 *   ② 同步行显示「领先 -1 / 落后 -1」（后端哨兵值直接渲染给用户）。
 * 因此这里在 node:vm 沙箱里装载真实 app-task-monitor.js，走完整链路
 *   syncWithView → openMonitor → loadAll → fetchJson → renderEnv → setBodyHtml
 * 然后断言 envBody.innerHTML 的最终形态。
 *
 * 【顺带守住的一个隐患】首行文案把彩色 +/- 以【裸 HTML】交给 row() 拼接。
 * row() 只对第四参 titleAttr 做 esc、正文 textHtml 原样进 innerHTML——这是对的，
 * 但一旦有人「顺手加个 esc」，用户就会看到字面 &lt;span&gt;。故每个含 +/- 的用例
 * 都断言 html 中不存在转义后的尖括号。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(__dirname, '..', '..', '..');
const JAVA_STATIC = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const SRC = fs.readFileSync(path.join(ROOT, 'ui/js/app-task-monitor.js'), 'utf8');
const ZH = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui/locales/zh-CN.json'), 'utf8'));

/** 复刻 app-i18n.js formatMessage 的占位符语义：{0}/{1} 按序替换 params。 */
function translate(key, params) {
    let tpl = ZH;
    for (const seg of String(key).split('.')) tpl = tpl && tpl[seg];
    if (typeof tpl !== 'string') return key;
    return tpl.replace(/\{(\d+)\}/g, (m, i) => (params && params[i] !== undefined ? params[i] : m));
}

/** 极简 DOM 桩：只实现 app-task-monitor.js 装载与渲染环境区所需的接口。 */
function makeDom(opts) {
    opts = opts || {};
    const byId = {};

    function mk(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            id: '', className: '', textContent: '', _html: '',
            attrs: {}, children: [], parentNode: null,
            classList: {
                add(c) { const s = new Set(classes(el)); s.add(c); el.className = [...s].join(' '); },
                remove(c) { el.className = classes(el).filter(x => x !== c).join(' '); },
                contains(c) { return classes(el).indexOf(c) >= 0; },
                toggle(c, force) {
                    const on = force === undefined ? !el.classList.contains(c) : !!force;
                    if (on) el.classList.add(c); else el.classList.remove(c);
                    return on;
                }
            },
            setAttribute(k, v) { el.attrs[k] = String(v); },
            getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
            removeAttribute(k) { delete el.attrs[k]; },
            appendChild(c) { el.children.push(c); c.parentNode = el; if (c.id) byId[c.id] = c; return c; },
            addEventListener() {},
            // initSections 只遍历 .tm-sec-head；本测试不验折叠，空集合即可
            querySelectorAll() { return []; },
            closest() { return null; }
        };
        Object.defineProperty(el, 'innerHTML', {
            get() { return el._html; },
            set(h) { el._html = String(h == null ? '' : h); }
        });
        return el;
    }

    function classes(el) { return String(el.className || '').split(/\s+/).filter(Boolean); }

    const body = mk('body');
    const drawer = mk('div'); drawer.id = 'taskMonitorDrawer';
    const envBody = mk('div'); envBody.id = 'tmEnvBody';
    const outputsBody = mk('div'); outputsBody.id = 'tmOutputsBody';
    const sourcesBody = mk('div'); sourcesBody.id = 'tmSourcesBody';
    const skillsBody = mk('div'); skillsBody.id = 'tmSkillsBody';
    const memoryRow = mk('div'); memoryRow.id = 'tmMemoryRow';
    const memoryLabel = mk('span'); memoryLabel.id = 'tmMemoryLabel';
    const memoryJumpBtn = mk('button'); memoryJumpBtn.id = 'tmMemoryJumpBtn';
    // chatView 带 .active 才算对话视图；isWelcomePage() 为 false 才会自动开面板
    const chatView = mk('div'); chatView.id = 'chatView';
    chatView.className = opts.chatActive === false ? '' : 'active';

    for (const el of [drawer, envBody, outputsBody, sourcesBody, skillsBody,
        memoryRow, memoryLabel, memoryJumpBtn, chatView]) {
        byId[el.id] = el;
        body.appendChild(el);
    }

    const document = {
        readyState: 'complete',
        body,
        documentElement: mk('html'),
        getElementById(id) { return byId[id] || null; },
        createElement: mk,
        addEventListener() {},
        querySelectorAll() { return []; }
    };
    return { document, byId, envBody, drawer, body, chatView };
}

/**
 * 构造 vm 沙箱。GourdI18n 在源码里是【裸全局】引用（function t(){ return GourdI18n.t(...) }，
 * 非 window.GourdI18n），故必须挂在沙箱顶层，只放 window 上会 ReferenceError。
 * fetchImpl 由调用方注入，成功/失败路径共用本工厂，避免两处 stub 漂移。
 */
function makeSandbox(dom, fetchImpl) {
    const sandboxWindow = {
        GourdI18n: { t: (k, p) => translate(k, p) },
        addEventListener() {},
        // 归属探测：返回 'local' 时环境行显示「本地」（与生产缺省一致）
        __currentChatWorkspaceScope: () => 'local'
    };
    sandboxWindow.window = sandboxWindow;

    const sandbox = {
        window: sandboxWindow,
        // 裸全局引用：源码里 t()/renderEnv 直接用 GourdI18n，不走 window 前缀
        GourdI18n: sandboxWindow.GourdI18n,
        document: dom.document,
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        setInterval() { return 1; },
        clearInterval() {},
        setTimeout(fn) { return fn && 0; },
        console,
        Promise,
        // app-base.js 的全局：X-Session-Cwd 头编码（中文路径修复）
        encodeSessionCwdHeader: (cwd) => (cwd ? encodeURIComponent(String(cwd)) : ''),
        // 会话上下文：resolveRoot(sid) 走 getSessionCwd() 分支
        SESSION_ID: 'sess-1',
        getSessionCwd: () => 'D:/work/proj',
        fetch: fetchImpl
    };
    return sandbox;
}

/** 装载真实源码并返回渲染后的环境区 HTML。routes: { '/web/chat/git/status': {...}, ... } */
async function renderEnvHtml(routes, opts) {
    const dom = makeDom(opts);
    const seenUrls = [];
    const fetchImpl = (url) => {
        seenUrls.push(url);
        const key = String(url).split('?')[0];
        const data = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : {};
        return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ code: 0, data })
        });
    };
    const sandbox = makeSandbox(dom, fetchImpl);
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'app-task-monitor.js' });

    // 脚本装载即 syncWithView() → openMonitor() → loadAll()；把 fetch/then 链跑完
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

    return { html: dom.envBody.innerHTML, seenUrls, sandbox, dom };
}

/** 环境区按行拆开，便于按语义定位（首行=变更统计，末行=同步态）。 */
function rowsOf(html) {
    return String(html).split('<div class="tm-row"').slice(1).map((r) => '<div class="tm-row"' + r);
}
function firstRow(html) { return rowsOf(html)[0] || ''; }
function lastRow(html) { const rs = rowsOf(html); return rs[rs.length - 1] || ''; }

const GIT = { gitAvailable: true, initialized: true, branch: 'main' };
const statusRoute = '/web/chat/git/status';
const remoteRoute = '/web/chat/git/remote';

/* ── 镜像一致性 ──────────────────────────────────────────────────── */

/* 为什么这条断言存在：上面的运行时用例只装载 desktop/ui 那一份源码。既然仓库契约是
   「前端唯一源 = gourd-work/desktop/ui，Java static 为镜像」（同 batch-count-contract
   对 app-turn-display.js 的处理），那么把同一组用例对着两份【字节相同】的文件跑两遍
   是纯冗余、零额外覆盖；真正会漏的是「只改了一份」。历史上确已发生单侧改镜像导致另一
   份静默失真的事故，故这里直接锁死两份必须字节一致 —— 单侧改动立刻红。 */
test('★ 两份镜像的 app-task-monitor.js / task-monitor.css 必须字节一致', () => {
    const pairs = [
        [path.join(ROOT, 'ui', 'js', 'app-task-monitor.js'), path.join(JAVA_STATIC, 'js', 'app-task-monitor.js')],
        [path.join(ROOT, 'ui', 'css', 'task-monitor.css'), path.join(JAVA_STATIC, 'css', 'task-monitor.css')]
    ];
    for (const [desktopFile, javaFile] of pairs) {
        for (const f of [desktopFile, javaFile]) assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
        const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
        assert.equal(md5(desktopFile), md5(javaFile),
            '两份镜像不一致（单侧改动）: ' + path.basename(desktopFile));
    }
});

test('★ monitor 文案键在两份 locales 里取值一致（12 语种）', () => {
    // 行为用例只用 zh-CN 断言文案，但两侧语言包若对同一 key 给出不同文案，
    // 同一份渲染逻辑在两个宿主里就会显示不同文字。这里锁住本次涉及的键。
    const KEYS = ['changes_count', 'no_changes', 'ahead_behind', 'synced', 'no_remote',
        'no_upstream', 'sync_unknown', 'commit_or_push', 'env_local', 'env_remote', 'no_git'];
    const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'el', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi'];
    for (const loc of LOCALES) {
        const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'ui', 'locales', loc + '.json'), 'utf8'));
        const b = JSON.parse(fs.readFileSync(path.join(JAVA_STATIC, 'locales', loc + '.json'), 'utf8'));
        for (const k of KEYS) {
            assert.equal((a.monitor || {})[k], (b.monitor || {})[k],
                loc + ' 的 monitor.' + k + ' 两份取值不一致');
        }
    }
});

test('装载即自动拉取环境区（链路真的跑通，不是空断言）', async () => {
    const { html, seenUrls } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(seenUrls.some((u) => u.startsWith(statusRoute)), '必须请求 /web/chat/git/status');
    assert.ok(seenUrls.some((u) => u.startsWith(remoteRoute)), '必须请求 /web/chat/git/remote');
    assert.ok(html.includes('tm-row'), '环境区必须渲染出行');
});

/* ── 缺陷①：有变更却一直显示「无变更」 ────────────────────────────── */

test('缺陷①：changed/staged/untracked 是【数组】，3 个文件必须显示「3 处变更」', async () => {
    // 旧代码 (status.changed || 0) + ... 对数组做加法 → 字符串拼接 → > 0 恒 false → 永远「无变更」
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: ['src/a.js', 'src/b.js'], staged: [], untracked: ['src/c.js'],
            additions: 12, deletions: 3
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(!html.includes('无变更'), '有变更却渲染「无变更」= 缺陷①回归');
    assert.ok(firstRow(html).includes('3 处变更'),
        '三个桶必须按 length 求和 = 2+0+1 = 3，实际首行：' + firstRow(html));
});

test('缺陷①：旧后端不回 additions 字段时仍须显示文件数（展示不劣化）', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: ['a.js', 'b.js', 'c.js'], staged: [], untracked: []
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(!html.includes('无变更'), '缺行级字段时不得退化成「无变更」');
    assert.ok(firstRow(html).includes('3 处变更'), '应回落「3 处变更」，实际：' + firstRow(html));
    assert.ok(!html.includes('tm-diff-add'), '无行级统计时不应渲染彩色 +/-');
});

test('干净工作区（空数组 + 0 增删）显示「无变更」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: [], staged: [], untracked: [], additions: 0, deletions: 0
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(firstRow(html).includes('无变更'), '干净工作区应显示「无变更」，实际：' + firstRow(html));
    assert.ok(!html.includes('tm-diff-add'), '干净工作区不应渲染彩色 +/-');
});

/* ── 参照稿形态：彩色行级 +/- ─────────────────────────────────────── */

test('参照稿：行级增删渲染为彩色 +3,019 / -363，且未被二次转义', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: ['a.js', 'b.js'], staged: ['c.js'], untracked: [],
            additions: 3019, deletions: 363
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(html.includes('<span class="tm-diff-add">+3,019</span>'),
        '缺少绿色 +3,019（千分位）：' + firstRow(html));
    assert.ok(html.includes('<span class="tm-diff-del">-363</span>'),
        '缺少红色 -363：' + firstRow(html));
    // row() 的 textHtml 必须原样进 innerHTML；一旦被 esc 用户就看到字面标签
    assert.ok(!html.includes('&lt;span'), '首行 HTML 被二次转义，用户会看到字面 <span> 文本');
    assert.ok(firstRow(html).includes('3 处变更'), '文件数应收进首行副文案');
    assert.ok(firstRow(html).includes('title="3 处变更"'), '文件数应收进 title 供悬停查看');
});

test('仅删除（additions=0）也须展示 -N，不得整体隐藏', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: ['a.js'], staged: [], untracked: [], additions: 0, deletions: 40
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(html.includes('<span class="tm-diff-add">+0</span>'), '缺 +0：' + firstRow(html));
    assert.ok(html.includes('<span class="tm-diff-del">-40</span>'), '缺 -40：' + firstRow(html));
});

/* ── 缺陷②：「领先 -1 / 落后 -1」哨兵泄漏 ─────────────────────────── */

test('缺陷②：双 -1 + degraded 显示「同步状态未知」，绝不露出 -1', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: -1, behind: -1, degraded: true }
    });
    assert.ok(lastRow(html).includes('同步状态未知'), '应显示「同步状态未知」，实际：' + lastRow(html));
    assert.ok(!html.includes('-1'), '哨兵 -1 泄漏给用户 = 缺陷②回归');
});

test('缺陷②：双 -1 且非降级按「已同步」展示（git 同步时本就省略尾缀）', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: -1, behind: -1 }
    });
    assert.ok(lastRow(html).includes('已同步'), '应显示「已同步」，实际：' + lastRow(html));
    assert.ok(!html.includes('-1'), '哨兵 -1 泄漏给用户');
});

test('单侧 -1（防御性分支）按 0 计，哨兵不外露', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: -1, behind: 2 }
    });
    assert.ok(!html.includes('-1'), '哨兵 -1 泄漏给用户');
    assert.ok(lastRow(html).includes('领先 0 / 落后 2'),
        'ahead 应按 0 计并保留 behind=2 信息，实际：' + lastRow(html));
});

/* ── 同步态其余分支 ───────────────────────────────────────────────── */

test('有未推送提交（ahead=2）显示行动提示「提交或推送」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 2, behind: 0 }
    });
    assert.ok(lastRow(html).includes('提交或推送'), '实际：' + lastRow(html));
});

test('本地有未提交变更（ahead=0/behind=0 但 changed 非空）显示「提交或推送」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: ['a.js'], staged: [], untracked: [], additions: 5, deletions: 0
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(lastRow(html).includes('提交或推送'),
        '有未提交变更时应提示行动，实际：' + lastRow(html));
});

test('仅落后（本地无可推送内容）保留信息型「领先 0 / 落后 3」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 3 }
    });
    assert.ok(lastRow(html).includes('领先 0 / 落后 3'), '实际：' + lastRow(html));
});

test('完全干净且同步显示「无变更」+「已同步」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, {
            changed: [], staged: [], untracked: [], additions: 0, deletions: 0
        }),
        [remoteRoute]: { hasRemote: true, upstream: 'origin/main', ahead: 0, behind: 0 }
    });
    assert.ok(firstRow(html).includes('无变更'), '实际首行：' + firstRow(html));
    assert.ok(lastRow(html).includes('已同步'), '实际末行：' + lastRow(html));
});

test('未配置远程 / 未关联上游 分支不受本次改动影响', async () => {
    const noRemote = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: false }
    });
    assert.ok(lastRow(noRemote.html).includes('未配置远程'), '实际：' + lastRow(noRemote.html));

    const noUpstream = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: [], staged: [], untracked: [] }),
        [remoteRoute]: { hasRemote: true, upstream: null, ahead: 0, behind: 0 }
    });
    assert.ok(lastRow(noUpstream.html).includes('未关联上游分支'), '实际：' + lastRow(noUpstream.html));
});

/* ── 降级与异常路径 ───────────────────────────────────────────────── */

test('status 接口失败渲染错误行，且不抛异常（面板不整块崩）', async () => {
    const dom = makeDom();
    const sandbox = makeSandbox(dom, (url) => {
        if (String(url).includes('/git/status')) return Promise.reject(new Error('HTTP 500'));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 0, data: {} }) });
    });
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'app-task-monitor.js' });
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));

    assert.ok(dom.envBody.innerHTML.includes('tm-error'),
        '失败态应渲染错误行，实际：' + dom.envBody.innerHTML);
    assert.ok(dom.envBody.innerHTML.includes('加载失败'), '错误文案缺失');
});

test('非 Git 仓库（gitAvailable=false）显示「非 Git 仓库」而非分支名', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: { gitAvailable: true, initialized: false, changed: [], staged: [], untracked: [] },
        [remoteRoute]: { hasRemote: false }
    });
    assert.ok(html.includes('非 Git 仓库'), '实际：' + html);
});

/* ── git 客户端未安装（用户提问的场景）────────────────────────────
   后端两内核都不会崩：Java status()/remoteInfo() 用 try-catch 包住 `git --version`
   （ProcessBuilder.start 抛 IOException 时返回 gitAvailable:false），Rust git() 把
   spawn 失败转成 exit code -1、git_available() 随之为 false。
   但降级后旧渲染把「没装 git」画成与「装了 git 但目录不是仓库」完全同形：
   行1「无变更」+ 行3「非 Git 仓库」+ 行4「未配置远程」（探针实测确认），
   用户会去 git init，而真正该做的是装 git。以下用例锁死二者的区分。 */
const NO_GIT_STATUS = { gitAvailable: false, initialized: false };
const NO_GIT_REMOTE = {
    gitAvailable: false, hasRemote: false, remoteUrl: null,
    upstream: null, ahead: -1, behind: -1, degraded: false
};

test('git 未安装：首行必须明说「未检测到 Git」，且不得谎报「无变更」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: NO_GIT_STATUS,
        [remoteRoute]: NO_GIT_REMOTE
    });
    assert.ok(firstRow(html).includes('未检测到 Git'),
        '主信息缺失，实际首行：' + firstRow(html));
    assert.ok(!html.includes('无变更'),
        '没查到 ≠ 没有变更：git 缺失时不得渲染「无变更」');
});

test('git 未安装：分支/同步行不得显示「非 Git 仓库」「未配置远程」', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: NO_GIT_STATUS,
        [remoteRoute]: NO_GIT_REMOTE
    });
    // 这两句是「装了 git」语境下的结论，用在缺客户端场景会把用户引向错误动作
    assert.ok(!html.includes('非 Git 仓库'), '误导：git 未安装却显示「非 Git 仓库」');
    assert.ok(!html.includes('未配置远程'), '误导：git 未安装却显示「未配置远程」');
    assert.ok(lastRow(html).includes('—'), '同步行应显示占位符，实际：' + lastRow(html));
});

test('git 未安装：占位行必须带原因到 title（悬停可查），且不重复刷屏', async () => {
    const { html } = await renderEnvHtml({
        [statusRoute]: NO_GIT_STATUS,
        [remoteRoute]: NO_GIT_REMOTE
    });
    const rs = rowsOf(html);
    // 主信息只说一次（首行），后两行用占位符 + title，避免三行重复同一句
    assert.equal(rs.filter(r => r.includes('未检测到 Git</span>')).length, 1,
        '「未检测到 Git」作为可见正文应只出现一次');
    const placeholderRows = rs.filter(r => r.includes('title="未检测到 Git"'));
    assert.equal(placeholderRows.length, 2,
        '分支行与同步行都应把原因收进 title，实际命中 ' + placeholderRows.length);
});

test('git 未安装 vs 非 Git 仓库：两种状态渲染结果必须可区分', async () => {
    const noGit = await renderEnvHtml({
        [statusRoute]: NO_GIT_STATUS,
        [remoteRoute]: NO_GIT_REMOTE
    });
    const notRepo = await renderEnvHtml({
        [statusRoute]: { gitAvailable: true, initialized: false, workspacePath: 'D:/x' },
        [remoteRoute]: { gitAvailable: true, hasRemote: false, degraded: true, ahead: -1, behind: -1 }
    });
    assert.notEqual(noGit.html, notRepo.html,
        '两种状态渲染相同（缺陷复现）：用户无法分辨该装 git 还是该 git init');
    assert.ok(notRepo.html.includes('非 Git 仓库'), '非仓库场景应保留原文案');
    assert.ok(notRepo.html.includes('未配置远程'), '非仓库场景应保留原文案');
});

test('仅 remote 报 git 缺失（status 缓存复用旧值）时同步行同样不得误导', async () => {
    // reuse 路径下 renderEnv 会拿到缓存的旧 status，只有 remote 是新值
    const { html } = await renderEnvHtml({
        [statusRoute]: Object.assign({}, GIT, { changed: ['a.js'], staged: [], untracked: [], additions: 3, deletions: 1 }),
        [remoteRoute]: NO_GIT_REMOTE
    });
    assert.ok(!lastRow(html).includes('未配置远程'),
        'remote 已明确 gitAvailable:false，同步行仍显示「未配置远程」= 误导');
    assert.ok(lastRow(html).includes('—'), '实际：' + lastRow(html));
});
