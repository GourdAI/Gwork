/**
 * 连接器·已安装卡片与技能·已安装卡片同款化（行为级回归）。
 *
 * ── 用户报障 ──────────────────────────────────────────────────────────────
 * 「连接器的已安装和技能已安装的显示不一样……按照技能的已安装卡片进行修改，
 * 同时显示名字和图片，现在显示的没有图片和名字」。
 *
 * 根因有两层，本文件把两层都钉死：
 *   ① 数据层：广场安装链路（normalize_server_config → mcp_server_add）只落
 *      运行字段，目录的 name/chinese_name/logo_url/description 被整体丢弃；
 *      /web/settings/mcp/servers 逐字段组装也不透传 → 前端永远拿不到图片和名字。
 *   ② 渲染层：renderMcpList 画的是 settings 旧长条行（字母占位 + 目录 key），
 *      与技能已安装卡（.skill-card-installed：图标 + 展示名 + 描述）形态割裂。
 *
 * ── 测试形态 ──────────────────────────────────────────────────────────────
 * 不做字符串凑数：用 node:vm 真跑 renderMcpList / mcpCardIconHtml / mcpIconSrc，
 * 断言产出的 HTML 结构与技能卡同构；后端链路用源码接线断言（键名 + 入口），
 * 行为级断言由 Rust 单测承担（build_entry_persists_display_metadata… /
 * mcp_market_install_carries_catalog_display_metadata）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(ROOT, 'gourd-work', 'desktop', 'ui');
const CORE = path.join(ROOT, 'gourd-work', 'core', 'src');
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

const settingsMcpJs = read(path.join(UI, 'js', 'app-settings-mcp.js'));
const skillsCss = read(path.join(UI, 'css', 'skills.css'));
const settingsApi = read(path.join(CORE, 'server', 'settings_api.rs'));
const marketApi = read(path.join(CORE, 'server', 'mcp_market_api.rs'));

/** 提取顶层函数源码（4 空格缩进的 function 块，到同缩进闭合括号为止）。 */
function fnSrc(name) {
    const re = new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    \\}');
    const m = re.exec(settingsMcpJs);
    assert.ok(m, '无法从 app-settings-mcp.js 提取 ' + name);
    return m[0];
}

/** 最小 jQuery / i18n 桩，真跑 renderMcpList 并收集产出 HTML。 */
function runRender(list, { apiUrl } = {}) {
    let html = null;
    const reported = [];
    const sandbox = {
        window: {},
        GourdI18n: { t: k => k },
        escapeHtml: s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        escapeAttr: s => String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        $mcpServerList: { html: h => { html = h; } },
    };
    sandbox.window._skillsReportMcpCount = n => reported.push(n);
    if (apiUrl) sandbox.window.__gworkApiUrl = apiUrl;
    vm.createContext(sandbox);
    vm.runInContext(
        fnSrc('mcpIconSrc') + '\n' + fnSrc('mcpCardIconHtml') + '\n' + fnSrc('renderMcpList')
        + '\nthis.__render = renderMcpList;',
        sandbox, { filename: 'app-settings-mcp.js#renderMcpList' });
    sandbox.__render(list);
    return { html, reported };
}

const MARKET_ITEM = {
    name: 'amap-maps', type: 'sse', enabled: true, scope: 'user',
    url: 'https://mcp.amap.com/sse',
    displayName: '高德地图', iconUrl: 'https://cdn.example.com/amap.png',
    description: '高德地图 MCP 服务',
};
const MANUAL_ITEM = {
    name: 'my-tool', type: 'stdio', enabled: false, scope: 'workspace',
    command: 'npx -y my-tool',
};

test('① 广场条目：卡片与技能已安装卡同构，图片 + 展示名 + 描述齐全', () => {
    const { html, reported } = runRender([MARKET_ITEM]);
    assert.match(html, /class="skill-card skill-card-installed mcp-installed-card"/,
        '必须复用技能已安装卡家族（.skill-card-installed），不得回到 .mcp-server-item 长条行');
    assert.match(html, /<div class="skill-card-icon">/, '图标容器与技能卡同款');
    assert.match(html, /<img src="[^"]*\/web\/settings\/skills\/icon\?url=https%3A%2F%2Fcdn\.example\.com%2Famap\.png"/,
        '图片必须走后端图标代理（与技能卡 iconSrc 同口径）');
    assert.match(html, /onerror="this\.remove\(\)"/, '加载失败自毁露出首字母底（技能卡同款降级）');
    assert.match(html, /<span class="skill-card-name" title="高德地图">高德地图<\/span>/,
        '标题必须是目录展示名，不是目录 key');
    assert.match(html, /<div class="skill-card-desc"[^>]*>高德地图 MCP 服务<\/div>/, '描述行');
    assert.match(html, /data-name="amap-maps"/, '操作定位键仍是真实目录名');
    assert.match(html, /skill-toggle mcp-toggle on/, '开关与技能卡同款（.skill-toggle）');
    assert.match(html, /mcp-edit-btn/, '编辑入口保留');
    assert.match(html, /mcp-delete-btn/, '删除入口保留');
    assert.deepEqual(reported, [1], '已安装计数徽标上报不得回归');
});

test('② 桌面壳：图标地址经 __gworkApiUrl 取内核绝对地址（SPA fallback 缺陷不得回归）', () => {
    const ORIGIN = 'http://127.0.0.1:51234';
    const { html } = runRender([MARKET_ITEM], { apiUrl: p => ORIGIN + p });
    assert.ok(html.includes('src="' + ORIGIN + '/web/settings/skills/icon?url='),
        '桌面壳下相对路径会落到 tauri.localhost 的 SPA fallback，图片永远只剩字母底');
    // 浏览器模式（无 helper）兜底相对路径
    const browser = runRender([MARKET_ITEM]);
    assert.match(browser.html, /src="\/web\/settings\/skills\/icon\?url=/);
});

test('③ 手动/旧条目：无元数据时回退目录名 + 首字母底，不画空白图', () => {
    const { html } = runRender([MANUAL_ITEM]);
    assert.match(html, /<span class="skill-card-name" title="my-tool">my-tool<\/span>/);
    assert.match(html, /<div class="skill-card-icon"><span>MY<\/span><\/div>/,
        '无 iconUrl 不得产出 <img>（空白图比字母底更糟）');
    assert.match(html, /skill-card-disabled/, '禁用态整卡降透明度（技能卡同款）');
    assert.match(html, /skill-toggle mcp-toggle(?! on)/, '禁用态开关不带 on');
    assert.match(html, /npx -y my-tool/, '无描述时回退命令/地址行，信息不丢');
    assert.match(html, /settings-scope-badge/, 'workspace 徽标保留');
});

test('④ 渲染层不得残留旧长条行形态（缺陷形态必须绝迹）', () => {
    const fn = fnSrc('renderMcpList');
    assert.ok(!fn.includes('mcp-server-item'), '已安装列表不得再画 .mcp-server-item');
    assert.ok(!fn.includes('iconMap'), 'S/R/H 字母占位映射已退役');
    assert.ok(!fn.includes('toggle-switch'), '开关换成技能卡 .skill-toggle');
    // 事件委托必须跟着卡片换选择器，否则整卡点击/开关全部失灵
    assert.match(settingsMcpJs, /\.on\('click', '\.mcp-installed-card'/);
    assert.match(settingsMcpJs, /\.on\('click', '\.mcp-toggle'/);
});

test('⑤ 数据层闭环：安装落盘 → 列表透传，三个展示字段一个都不能少', () => {
    // McpBody 接收三个展示字段（serde rename 与前端读取的键名一致）
    assert.match(settingsApi, /#\[serde\(rename = "displayName", default\)\]\s*\n\s*pub display_name/);
    assert.match(settingsApi, /#\[serde\(rename = "iconUrl", default\)\]\s*\n\s*pub icon_url/);
    // build_entry 落盘 + update 保留（编辑表单不提交这三个字段）
    assert.match(settingsApi, /prev_meta\("displayName", &body\.display_name\)/);
    assert.match(settingsApi, /prev_meta\("iconUrl", &body\.icon_url\)/);
    assert.match(settingsApi, /prev_meta\("description", &body\.description\)/);
    // mcp_servers 逐字段组装必须显式透传，否则前端永远拿不到。
    // 2026-11 安装链路修复轮：数组新增 marketId（修4 广场已安装态的匹配口径，
    // 同为非密钥展示元数据）。三个展示字段的断言逐一保留，不因子串匹配而弱化。
    assert.match(settingsApi, /for key in \["displayName", "iconUrl", "description", "marketId"\]/);
    ['displayName', 'iconUrl', 'description'].forEach(k =>
        assert.ok(settingsApi.includes('"' + k + '"'), '透传名单缺展示字段 ' + k));
    // install 必经之路注入目录元数据 + marketId（接线点被删会立刻红）
    assert.match(marketApi, /attach_catalog_meta\(&data, &body\.id, &mut entries\)/);
    assert.match(marketApi, /fn catalog_display_name[\s\S]*?"chinese_name", "name"/,
        '展示名 chinese_name 优先，与广场卡片 pickText 同口径');
});

test('⑥ CSS：网格密度与技能列表一致，侧栏三件套不挤压标题', () => {
    assert.match(skillsCss, /#skillsPaneConnectors \.mcp-server-list \{ grid-template-columns: repeat\(auto-fill, minmax\(300px, 1fr\)\); \}/,
        '与 .skills-list 同密度（minmax 300px）');
    assert.match(skillsCss, /\.skill-card\.mcp-installed-card \{ --side-gutter: 110px; \}/,
        '三件套侧栏（编辑+删除+开关=104px）必须放大标题预留宽，双类压过 72px 不依赖加载顺序');
    assert.match(skillsCss, /#skillsPaneConnectors \.mcp-card-side \{ width: 104px; \}/);
    assert.match(skillsCss, /#skillsPaneConnectors \.mcp-installed-card:hover \{ border-color: var\(--accent\)/,
        '连接器卡可点开工具面板，hover 高亮必须恢复（技能已安装卡默认不高亮）');
    /* codereview P1 回归：新卡按钮挂着旧 .mcp-action-btn 类，旧规则
     * `#skillsPaneConnectors .mcp-action-btn{opacity:0}` 的显形入口只认
     * .mcp-server-item —— 不显式恢复 opacity，visibility:visible 也救不回，
     * 编辑/删除按钮将永远隐形（hover 也看不见）。 */
    assert.match(skillsCss, /#skillsPaneConnectors \.mcp-action-btn,\s*\n#skillsPaneInterfaces \.mcp-action-btn \{ opacity: 0;/,
        '前提：旧规则仍在（若已删除本断言应随之更新）');
    assert.match(skillsCss, /#skillsPaneConnectors \.mcp-installed-card \.mcp-action-btn \{ opacity: 1; \}/,
        '新卡必须显式恢复按钮 opacity，否则编辑/删除永远隐形');
});

/* ── codereview 修复的行为级回归（vm 真跑，不做字符串凑数） ─────────────── */

/** 提取 mcpToggleServer / syncMcpCardDisabled / mcpConfirmRemoveServer 真跑。 */
function runToggle({ fail = false, resp = { code: 200 } } = {}) {
    const calls = [];
    let reloads = 0;
    let btnState = { disabled: true, on: true, enabledAttr: '1', aria: 'true' };
    let cardDisabled = false;
    const $btn = {
        length: 1, 0: {},
        prop(k, v) { if (v === undefined) return btnState[k]; btnState[k] = v; return this; },
        toggleClass(cls, on) { if (cls === 'on') btnState.on = on; return this; },
        attr(k, v) {
            if (v === undefined) return k === 'data-enabled' ? btnState.enabledAttr : btnState.aria;
            if (k === 'data-enabled') btnState.enabledAttr = v; else btnState.aria = v;
            return this;
        },
        closest() { return { toggleClass(cls, off) { cardDisabled = off; return this; } }; },
    };
    const sandbox = {
        document: { body: {} },
        $: { contains: () => true },
        GourdI18n: { t: k => k },
        showToast: (m, t) => calls.push(['toast', t]),
        loadMcpList: () => { reloads++; },
        postJson: (url, data, doneFn, alwaysFn) => {
            calls.push(['post', data]);
            if (!fail) doneFn(resp);
            if (alwaysFn) alwaysFn();
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        fnSrc('syncMcpCardDisabled') + '\n' + fnSrc('mcpToggleServer')
        + '\nthis.__toggle = mcpToggleServer;', sandbox,
        { filename: 'app-settings-mcp.js#mcpToggleServer' });
    sandbox.__toggle('amap-maps', true, $btn);
    return { btnState, cardDisabled, reloads, calls };
}

test('⑦ 开关网络失败：always 回调必须解锁并回滚乐观翻转（防连点不得变死锁）', () => {
    const r = runToggle({ fail: true });
    assert.equal(r.btnState.disabled, false, '网络失败走 .fail 不走 done，不解锁开关就永远点不动');
    assert.equal(r.btnState.on, false, '失败必须回滚到原状态（原为禁用→请求启用失败→回到禁用）');
    assert.equal(r.btnState.enabledAttr, '0');
    assert.equal(r.btnState.aria, 'false');
    assert.equal(r.cardDisabled, true, '整卡置灰态一并回滚');
});

test('⑧ 开关成功：done 刷新列表；按钮仍在 DOM 时 always 回滚（随后重绘终态覆盖）', () => {
    const r = runToggle({});
    assert.equal(r.reloads, 1, '成功回调必须刷新列表（终态以服务端为准）');
    assert.equal(r.btnState.disabled, false, '防连点锁必须解除（重绘前按钮仍可交互）');
    /* 语义说明：done 先 loadMcpList（异步），always 随后对旧按钮回滚——
     * 旧按钮即将被重绘替换，终态由服务端数据决定；$.contains 守卫只在
     * 按钮已被替换（不在 DOM）时跳过，避免操作游离节点。 */
});

test('⑨ 乐观翻转必须同步整卡置灰态；删除确认用展示名', () => {
    // 点击处理器必须调 syncMcpCardDisabled（只翻按钮不翻卡 = 启用了还半透明）
    const clickHandler = /\.on\('click', '\.mcp-toggle'[\s\S]*?\n        \}\)/.exec(settingsMcpJs);
    assert.ok(clickHandler, '找不到开关点击处理器');
    assert.match(clickHandler[0], /syncMcpCardDisabled\(\$btn, enabled\)/,
        '乐观翻转后整卡 skill-card-disabled 必须跟着翻');
    assert.match(clickHandler[0], /mcpToggleServer\(\$btn\.attr\('data-name'\), enabled, \$btn\)/,
        '必须把 $btn 传给 mcpToggleServer，否则失败无法回滚');
    // 删除确认：卡上写「高德地图」，弹窗不得问「确定删除 amap-maps 吗」
    const delHandler = /\.on\('click', '\.mcp-delete-btn'[\s\S]*?\n        \}\)/.exec(settingsMcpJs);
    assert.ok(delHandler && /skill-card-name/.test(delHandler[0]),
        '删除确认可视名必须取卡片展示名（真实请求体仍是目录名）');
    assert.match(fnSrc('mcpConfirmRemoveServer'), /var label = shownName \|\| name;/);
    assert.match(fnSrc('mcpConfirmRemoveServer'), /mcpRemoveServer\(name\);/,
        '请求体仍传真实目录名，展示名只进文案');
});