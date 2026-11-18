/* ===== 连接器目录（魔搭/腾讯云/Smithery）+ 三 Tab 接线契约 =====
 *
 * 2026-11 SolonCode 集成轮（用户拍板）：三个内置目录源 = 魔搭 ModelScope（默认）
 * + 腾讯云 MCP 广场 + Smithery（SolonCode v2026.11 同源契约），二级导航按技能页
 * 「已安装/各市场」同构直切，「广场」中间层 tab 退役。不做用户自定义目录源 /
 * MCP 官方 Registry / deploy / operational；自建官方连接器源（admin 远程目录）
 * 与随它提供数据的厂商命令行连接器流程均已整体下线（见被删测试 ㉒~㉕/㉙ 的历史）。
 * 「手动添加 MCP」入口在全部连接器视图可见（用户报障：目录视图找不到入口）。
 *
 * 本测试专抓「接线断点」：脚本加载顺序、宿主容器（不能把整个 pane 当宿主，
 * 否则 innerHTML 会冲掉迁入的 MCP 配置 DOM）、手动添加按钮、后端路由、i18n 键集。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(REPO, 'gourd-work', 'desktop', 'ui');
const ST = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const read = p => fs.readFileSync(p, 'utf8');
const VARIANTS = [{ tag: 'desktop', base: UI }, { tag: 'static', base: ST }];

function flatKeys(obj, prefix, out) {
  Object.keys(obj).forEach(k => {
    const key = prefix ? prefix + '.' + k : k;
    if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) flatKeys(obj[k], key, out);
    else out.add(key);
  });
  return out;
}

test('① app-skills.js 是「3 主 tab + 技能内二级源」两级结构', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-skills.js'));
    ["var VIEW_CONNECTORS = 'connectors'", "var VIEW_INTERFACES = 'interfaces'",
      "var MAIN_SKILLS = 'skills'"].forEach(k =>
      assert.ok(s.includes(k), v.tag + ': 缺常量 ' + k));

    // 顶栏 renderMainTabs：只产出 3 个主 tab（技能 / 连接器 / 接口），用 data-main
    assert.match(s, /function renderMainTabs\(/, v.tag + ': 缺 renderMainTabs');
    assert.match(s, /data-main="'\s*\+\s*MAIN_SKILLS/, v.tag + ': 缺「技能」主 tab');
    assert.match(s, /data-main="'\s*\+\s*VIEW_CONNECTORS/, v.tag + ': 缺「连接器」主 tab');
    assert.match(s, /data-main="'\s*\+\s*VIEW_INTERFACES/, v.tag + ': 缺「接口」主 tab');
    assert.match(s, /GourdI18n\.t\('app\.nav\.connectors'\)/, v.tag + ': 连接器 tab 未走 i18n');
    assert.match(s, /GourdI18n\.t\('app\.nav\.interfaces'\)/, v.tag + ': 接口 tab 未走 i18n');
    // 顶栏里绝不能再出现「已安装 / 市场名」这些二级源（它们已收进技能模块）
    const mainFn = s.match(/function renderMainTabs\([\s\S]*?\n    \}/);
    assert.ok(mainFn, v.tag + ': 无法定位 renderMainTabs 函数体');
    assert.ok(!/VIEW_INSTALLED|_markets\.forEach|marketLabel/.test(mainFn[0]),
      v.tag + ': 顶栏主 tab 里混入了二级技能源（已安装 / 各市场），层级应收敛为 3 个');

    // 技能内二级源：已安装 + 各市场，用 data-view
    assert.match(s, /function renderSourceTabs\(/, v.tag + ': 缺 renderSourceTabs');
    const srcFn = s.match(/function renderSourceTabs\([\s\S]*?\n    \}/);
    assert.ok(srcFn, v.tag + ': 无法定位 renderSourceTabs 函数体');
    assert.match(srcFn[0], /data-view="'\s*\+\s*VIEW_INSTALLED/, v.tag + ': 二级源缺「已安装」');
    assert.match(srcFn[0], /_markets\.forEach/, v.tag + ': 二级源缺各市场');
    assert.match(srcFn[0], /\$skillsSourceTabs\.html/, v.tag + ': 二级源未渲染到 #skillsSourceTabs');

    // 事件层分派：主 tab 走 switchMain(data-main)，二级源走 switchView(data-view)
    assert.match(s, /\.skills-main-tab[\s\S]{0,120}switchMain/, v.tag + ': 主 tab 未接 switchMain');
    assert.match(s, /\.skills-source-tab[\s\S]{0,120}switchView/, v.tag + ': 二级源未接 switchView');
    assert.match(s, /function switchMain\(/, v.tag + ': 缺 switchMain');

    // showPane：二级源栏只在技能主 tab 显示；连接器/接口隐藏
    assert.match(s, /function showPane\(view\)/, v.tag + ': 缺 showPane');
    assert.match(s, /skillsPaneConnectors/, v.tag + ': showPane 未切换连接器 pane');
    assert.match(s, /skillsPaneInterfaces/, v.tag + ': showPane 未切换接口 pane');
    const paneFn = s.match(/function showPane\(view\)[\s\S]*?\n    \}/);
    assert.ok(paneFn, v.tag + ': 无法定位 showPane 函数体');
    assert.match(paneFn[0], /\$skillsSourceBarWrap[\s\S]{0,80}\.toggle\(isSkills\)/,
      v.tag + ': 二级源栏未随「技能」主 tab 显隐（连接器/接口页不得残留源切换）');
    assert.match(s, /_settingsMcp[\s\S]{0,120}\.load\(\)/, v.tag + ': 进入连接器未加载 MCP 配置');
    assert.match(s, /_settingsOpenapi[\s\S]{0,120}\.load\(\)/, v.tag + ': 进入接口未加载 OpenAPI 配置');
    // 关键回归：宿主必须是目录容器，不能是整块 pane
    assert.match(s, /setHost\('#mcpMarketRoot'\)/, v.tag + ': 市场宿主必须是 #mcpMarketRoot');
    assert.ok(!s.includes("setHost('#skillsPaneConnectors')"),
      v.tag + ': 把整个 pane 当宿主会 innerHTML 冲掉迁入的 #mcpAddBtn 等配置 DOM');
  });
});

test('② 保留「手动添加 MCP」入口（用户明确要求）', () => {
  VARIANTS.forEach(v => {
    const html = read(path.join(v.base, 'skills.html'));
    assert.match(html, /id="skillsAddMcpBtn"/, v.tag + ': 缺手动添加按钮');
    assert.match(html, /id="mcpAddBtn"/, v.tag + ': 迁入的 MCP 添加表单入口丢失');
    const js = read(path.join(v.base, 'js', 'app-skills.js'));
    assert.match(js, /\$\(document\)\.on\('click',\s*'#skillsAddMcpBtn'/, v.tag + ': 按钮未用委托绑定');
    assert.match(js, /#mcpAddBtn'\)\.trigger\('click'\)|#mcpAddBtn'\)/, v.tag + ': 未复用 #mcpAddBtn 表单');
  });
});

test('③ bootstrap 加载 app-mcp-market.js，且必须在 app-skills.js 之前', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-bootstrap.js'));
    assert.match(s, /'\/js\/app-mcp-market\.js',/, v.tag + ': 未加载市场模块');
    const iMcp = s.indexOf('app-mcp-market.js'), iSkills = s.indexOf('app-skills.js');
    assert.ok(iMcp > 0 && iSkills > iMcp, v.tag + ': 市场模块必须在 app-skills.js 之前');
    assert.ok(!/\/app-mcp-market\.js',\s*\n\s*\n/.test(s), v.tag + ': 加载数组有空行残留');
  });
  const idx = read(path.join(UI, 'index.html'));
  assert.match(idx, /css\/mcp-market\.css/, 'desktop: 未引入市场样式');
  assert.match(read(path.join(ST, 'index.html')), /css\/mcp-market\.css/, 'static: 未引入市场样式');
});

test('④ 市场模块三个内置目录源（魔搭/腾讯云/Smithery），不硬编码 Token，不实现自建官方源/用户自定义源', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.match(s, /\/web\/settings\/mcp\/market\/servers/, v.tag + ': 未接后端列表端点');
    assert.match(s, /\/web\/settings\/mcp\/market\/install/, v.tag + ': 未接一键安装端点');
    /* 2026-11 集成 SolonCode v2026.11 连接器市场：三个内置目录源
     * modelscope（默认）/ tencent / smithery，源切换走 app-skills.js 二级导航
     * （与技能页「已安装/各市场」同构，用户拍板「不要再显示广场」）。
     * 已删除且不得复活的是**自建官方源**（official）与用户自定义目录源
     * （addSource/customSource —— 用户明确否决过），与本轮三个公开目录源无关。 */
    assert.match(s, /SOURCES\s*=\s*\['modelscope',\s*'tencent',\s*'smithery'\]/,
      v.tag + ': 三源白名单漂移（须与后端 normalize_source 同口径）');
    assert.match(s, /state\.source/, v.tag + ': 缺 state.source（多源状态）');
    assert.match(s, /p\.set\('source'/, v.tag + ': 列表查询必须携带 source 参数');
    assert.match(s, /setSource/, v.tag + ': 缺 setSource（源切换入口）');
    assert.ok(!/mcpMarketSourceTabs|mcp-market-source-tab|syncSourceTabs/.test(s),
      v.tag + ': 壳内源 tabs 已退役（源切换统一在 app-skills.js 二级导航）');
    assert.ok(!/'official'|"official"/.test(s), v.tag + ': 不得残留自建官方源字面量');
    assert.ok(!/Authorization:\s*Bearer|api[_-]?key\s*[:=]\s*['"]ms-/.test(s),
      v.tag + ': 不得硬编码任何 Token（Smithery key 走 CredentialVault）');
    assert.ok(!/registry\.modelcontextprotocol\.io/.test(s),
      v.tag + ': MCP 官方 Registry 未启用（SolonCode 自己也注释停用），不得引入');
    assert.ok(!/addSource|customSource|sourceManager/.test(s),
      v.tag + ': 用户明确否决自定义目录源（三个内置源之外不加源管理）');
    /* 分页判定按源：魔搭 100 条窗口钳制必须保留；腾讯/Smithery 无窗口。 */
    assert.match(s, /hasMorePages/, v.tag + ': 缺分页判定');
    assert.match(s, /state\.source === 'modelscope'[\s\S]{0,80}< 100/,
      v.tag + ': 魔搭 100 条窗口钳制丢失');
  });
});

test('⑤ 后端注册 4 个路由且复用 mcp_server_add 持久化', () => {
  const mod = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'mod.rs'));
  ['/web/settings/mcp/market/servers', '/web/settings/mcp/market/detail',
    '/web/settings/mcp/market/categories', '/web/settings/mcp/market/install']
    .forEach(r => assert.ok(mod.includes(r), 'server/mod.rs 未注册 ' + r));
  const h = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'mcp_market_api.rs'));
  assert.match(h, /mcp_server_add\(/, '一键安装必须复用 mcp_server_add（同一校验/去重/热插拔）');
  assert.match(h, /resolve_env/, '必填环境变量必须校验');
  const m = read(path.join(REPO, 'gourd-work', 'core', 'src', 'mcp', 'market.rs'));
  assert.match(m, /page\s*\*\s*page_size|page_number\s*\*\s*page_size|clamp/i, '必须钳制上游 100 条分页窗口');
});

test('⑥ 24 份语言包含 settings.mcp.market.* 且键集一致', () => {
  [path.join(UI, 'locales'), path.join(ST, 'locales')].forEach(dir => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    assert.equal(files.length, 12, dir + ': 应有 12 份语言包');
    const sigs = new Set(files.map(f => [...flatKeys(JSON.parse(read(path.join(dir, f))), '', new Set())].sort().join('|')));
    assert.equal(sigs.size, 1, dir + ': 键集不一致（locale-parity 会红）');
    files.forEach(f => {
      const mkt = JSON.parse(read(path.join(dir, f))).settings.mcp.market;
      assert.ok(mkt, f + ': 缺 settings.mcp.market');
      /* 键集与 WorkBuddy 式弹窗改造后的实现同步（2026-11 codereview 轮）：
       *  · install → connect / save_connect（已移除）
       *  · try_it  → 随「试试这样用」区块一并删除。该区块曾从 readme 列表项
       *    提炼示例，实测提炼出的是「需要 Python 3.10」「uv >= 0.1.30」
       *    「本项目采用 MIT 许可证开源」—— 用格式判据冒充语义判据，
       *    属于 P0 级虚假内容。上游魔搭详情没有示例字段，用户拍板整块砍掉。
       *  · detail  → 卡片按钮改成与技能卡同形态的 `+` 号图标按钮后，
       *    「详情」文字按钮取消（点整卡即开弹窗），故键废弃。
       *  · 新增 load_failed / install_failed / installed_names / detail_failed
       *    （带 {msg} 占位）与 retry：此前错误文案硬编码中文，12 语种下
       *    英文用户会看到中文 toast。
       * 既防缺键（界面裸键）也防死键复活。 */
      ['title', 'source_modelscope', 'source_tencent', 'source_smithery',
        'search_placeholder', 'installed', 'empty', 'required',
        'verified', 'connect', 'connect_title', 'save_connect', 'cancel', 'config',
        'load_failed', 'install_failed', 'installed_names', 'detail_failed', 'retry',
        'oauth_badge', 'token_badge', 'saved_connect_failed', 'installed_badge']
        .forEach(k => assert.equal(typeof mkt[k], 'string', f + ': 缺 ' + k));
      assert.ok(!('install' in mkt), f + ': install 键已废弃（UI 改用 connect/save_connect），不得复活');
      /* 死键反向断言：try_it / detail 若复活，说明「示例区」或「详情文字按钮」
       * 被重新引入 —— 前者是已定性的 P0 虚假内容，后者与整卡点击语义重复。 */
      assert.ok(!('try_it' in mkt), f + ': try_it 已随「试试这样用」区块删除，不得复活');
      assert.ok(!('detail' in mkt), f + ': detail 已随卡片文字按钮删除，不得复活');
      /* 「精选」概念移除（featured_only/featured_badge 死键不得复活）。 */
      assert.ok(!('featured_only' in mkt), f + ': featured_only 已随「精选」概念移除，不得复活');
      assert.ok(!('featured_badge' in mkt), f + ': featured_badge 已随「精选」概念移除，不得复活');
      /* 自建官方源死键不得复活（source_official）。source_modelscope 在
       * SolonCode 集成轮以「三源 tab 展示名」语义回归（见上方必含键集），
       * 与已删除的官方/魔搭双源 tabs 无关。 */
      assert.ok(!('source_official' in mkt), f + ': source_official 已随自建官方源下线，不得复活');
      /* 「广场」中间层 tab 退役（用户拍板：按技能那样三源直切），market_tab 死键。 */
      assert.ok(!('market_tab' in mkt), f + ': market_tab 已随「广场」tab 退役，不得复活');
      /* qrcode_poll 厂商扫码徽标已随官方源下线：后端 AuthKind::parse 把
       * qrcode_poll/qrcode/qr_poll/scan 一族归入 None（不再授权），前端徽标必须
       * 同口径删除，否则卡片画「扫码授权」却根本不走扫码 = 误导。scan_badge 死键不得复活。 */
      assert.ok(!('scan_badge' in mkt), f + ': scan_badge 已随 qrcode_poll 扫码徽标下线，不得复活');
      /* 厂商命令行连接器（钉钉/企微/飞书/腾讯会议）整条 UI 已下线：其安装参数
       * 100% 来自官方目录，官方源一删就没有数据来源。26 个 cli_* 键不得复活。 */
      ['cli_badge', 'cli_connect', 'cli_connected', 'cli_disconnect', 'cli_disconnect_confirm',
        'cli_disconnected', 'cli_disconnect_failed', 'cli_preparing_node', 'cli_installing_cli',
        'cli_installing_skills', 'cli_scan_with', 'cli_scan_generic', 'cli_open_browser',
        'cli_auth_pending', 'cli_auth_success', 'cli_auth_failed', 'cli_auth_expired',
        'cli_node_failed', 'cli_install_failed', 'cli_skills_included', 'cli_source',
        'cli_app_dingtalk', 'cli_app_wecom', 'cli_app_feishu', 'cli_app_tmeet', 'cli_qr_invalid']
        .forEach(k => assert.ok(!(k in mkt), f + ': ' + k + ' 已随官方源下线删除，不得复活'));
      assert.ok(!Object.keys(mkt).some(k => /^cli_/.test(k)),
        f + ': settings.mcp.market 下不得再出现任何 cli_* 键');
      /* 2026-11 codereview 轮：hosted 是「已托管」勾选退役后残留的死键
       * （前端零引用），24 份语言包一并删除，反向断言防复活。 */
      assert.ok(!('hosted' in mkt), f + ': hosted 已随「已托管」概念移除，不得复活');
      /* 带占位符的错误文案必须真的含 {msg}，否则 GourdI18n 插值失效、
       * 界面上会漏出字面 {msg} 或丢掉真实错误原因。 */
      ['load_failed', 'install_failed', 'installed_names', 'detail_failed', 'saved_connect_failed']
        .forEach(k => assert.ok(mkt[k].includes('{msg}'), f + ': ' + k + ' 缺 {msg} 占位符'));
      /* 2026-11 排版重构：+market_tab（连接器二级导航「广场」标签，与技能页
       * 「已安装/各市场」同构）。17→18。
       * 2026-11 精选目录+真扫码：+featured_only/featured_badge/scan_badge/token_badge。18→22。
       * 2026-11 官方仓库轮：-featured_only/-featured_badge（精选概念移除），
       * +source_official/source_modelscope/oauth_badge。22→23。
       * 2026-11 codereview 轮：-hosted（「已托管」死键清除）。23→22。
       * 厂商命令行连接器轮：+cli_* 26 键。22→48。
       * 2026-11 用户拍板砍掉自建官方源：-source_official/-source_modelscope（目录源 tabs
       * 退役）/-cli_* 26 键（该流程数据源消失，UI 整体下线）。48→20。
       * 2026-11 codereview 轮：-scan_badge（qrcode_poll 扫码徽标随后端归 None 一并下线）。20→19。
       * 2026-11 安装链路修复轮：+saved_connect_failed（修1「已保存但连接失败」warning
       * toast，带 {msg}）/+installed_badge（修4 广场卡片与详情弹窗的「已安装」徽标）。19→21。
       * 2026-11 SolonCode 集成轮：-market_tab（「广场」中间层 tab 退役，三源直切）
       * +source_modelscope/+source_tencent/+source_smithery（源 tab 展示名）。21→23。 */
      assert.equal(Object.keys(mkt).length, 23, f + ': market 键数漂移，键集契约需同步更新');
      /* connect_title 是纯标题（调用处不传 params），不得残留 {msg} 占位符——
       * zh-TW 曾写成「連接 {msg}」，界面直接漏出字面占位符。 */
      assert.ok(!String(mkt.connect_title || '').includes('{msg}'),
        f + ': connect_title 不得含 {msg} 占位符');
    });
  });
});

/* ===== ⑦ 运行时行为护栏 =====
 *
 * 上面 6 条全是「读源码找字符串」的静态断言。P1（委托监听器在持久 root 上
 * 每次 render 重绑 → 一次点击 install() 被调 N 次 → 后端 400 重名误报失败）
 * 就是静态断言测不出来的运行时缺陷，全量测试 435 绿也照样放行。
 *
 * 因此这里用 vm 沙箱加载**真实模块源码**，配最小 DOM stub，实际跑 render()
 * 若干轮再派发点击，断言安装回调只被触发一次。
 */
const vm = require('node:vm');

function makeEl(id) {
  const el = {
    id, _ls: {}, _html: '', children: [],
    style: {}, attrs: {},
    addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
    listenerCount(t) { return (this._ls[t] || []).length; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    closest() { return null; },
    // 模拟 innerHTML 替换：只丢子节点，root 自身的监听器必须保留（DOM 真实语义）
    set innerHTML(v) { this._html = v; this.children = []; },
    get innerHTML() { return this._html; },
  };
  return el;
}

function loadMarketModule(tag, file) {
  const root = makeEl('mcpMarketRoot');
  const byId = { mcpMarketRoot: root };
  const installed = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    URLSearchParams,
    document: {
      getElementById: (id) => byId[id] || null,
      querySelector: (sel) => (sel === '#mcpMarketRoot' ? root : null),
      addEventListener() {},
    },
    window: { addEventListener() {}, showToast() {}, GourdI18n: null },
    // 桩掉 fetch：列表返回 1 张卡片，安装记录调用次数
    fetch: async (url) => {
      if (/market\/install/.test(url)) { installed.push(url); return { ok: true, status: 200, json: async () => ({ code: 200, data: { installed: ['fetch'] } }) }; }
      if (/market\/detail/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 200, data: { server_config: [{ mcpServers: { fetch: { command: 'uvx' } } }], env_schema: { properties: {}, required: [] } } }) };
      if (/market\/categories/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 200, data: [{ key: '', nameZh: '全部', name: 'All' }] }) };
      return { ok: true, status: 200, json: async () => ({ code: 200, data: { total_count: 1, mcp_server_list: [{ id: '@a/b', name: 'B' }] } }) };
    },
    Element: function () {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox, { filename: file });

  // render 是内部函数，通过对外 load()/refresh() 驱动（它们都会走 render→bind）
  const market = sandbox.window._mcpMarket;
  assert.ok(market && typeof market.setHost === 'function', tag + ': 模块未导出 window._mcpMarket');
  market.setHost('#mcpMarketRoot');
  return { tag, root, sandbox, installed, market };
}

test('⑦ 重复 load() 后一次点击只触发一次安装（P1 回归护栏）', async () => {
  for (const base of [UI, ST]) {
    const tag = base === UI ? 'desktop' : 'static';
    const ctx = loadMarketModule(tag, path.join(base, 'js', 'app-mcp-market.js'));
    // 模拟用户翻 5 次页 / 切 5 次分类：每轮 load 都会 render → bind
    for (let i = 0; i < 5; i++) await ctx.market.refresh();

    assert.equal(ctx.root.listenerCount('click'), 1,
      tag + ': 持久 root 上的委托监听器累积成 ' + ctx.root.listenerCount('click') +
      ' 个（每次 render 重绑）。innerHTML 只换子节点、不会移除 root 自身监听器，' +
      '必须记忆化只绑一次，否则一次点击 install() 被调 N 次，' +
      '后端对重名返回 400，用户看到「已安装」紧跟「安装失败：Server name already exists」');

    // 真实派发一次点击，验证安装只发生一次
    const fakeBtn = { getAttribute: (k) => (k === 'data-act' ? 'install' : '@a/b'), closest: function (s) { return s === '[data-act]' ? this : null; } };
    (ctx.root._ls.click || []).forEach(f => f({ target: fakeBtn }));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ctx.installed.length, 1,
      tag + ': 一次点击触发了 ' + ctx.installed.length + ' 次安装请求');
  }
});

test('⑧ 前端不得把空串 category 发给后端（P0 上游契约护栏）', () => {
  // 实测：上游 filter 里出现空串 category 键 → total_count=0（{"filter":{}} → 12799）。
  // 前端只在有值时才 set('category')；后端 list_body 也必须空则省略该键。
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.match(s, /if \(state\.category\) p\.set\('category'/,
      v.tag + ': category 为空时必须不发该参数，否则上游返回 0 条');
    assert.ok(!/p\.set\('category',\s*''\)/.test(s), v.tag + ': 禁止硬编码空串 category');
  });
  const m = read(path.join(REPO, 'gourd-work', 'core', 'src', 'mcp', 'market.rs'));
  assert.match(m, /if !cat\.is_empty\(\)/,
    'list_body 必须在 category 为空时省略该键（上游空串 category → total_count=0）');
});

/* ===== ⑨~⑫ 本轮（3 主 tab + 技能内二级 tab / 主题配色 / 详情弹窗）护栏 ===== */

test('⑨ 两级 tab 的 DOM 骨架在双端齐全且默认隐藏二级源栏', () => {
  VARIANTS.forEach(v => {
    const html = read(path.join(v.base, 'skills.html'));
    assert.match(html, /id="skillsViewTabs"/, v.tag + ': 缺顶栏主 tab 容器');
    assert.match(html, /id="skillsSourceTabs"/, v.tag + ': 缺技能内二级源容器');
    assert.match(html, /id="skillsSourceBarWrap"[^>]*style="display:none"/,
      v.tag + ': 二级源栏应默认隐藏（仅技能主 tab 激活时显示）');
    assert.match(html, /id="skillsCategoryBarWrap"/, v.tag + ': 市场分类 chips 必须保留在二级源下方');
    // 二级源栏必须排在分类栏之前（层级：主 tab → 二级源 → 分类 chips）
    assert.ok(html.indexOf('id="skillsSourceTabs"') < html.indexOf('id="skillsCategoryBarWrap"'),
      v.tag + ': 二级源栏应位于分类 chips 之上');
    const css = read(path.join(v.base, 'css', 'skills.css'));
    assert.match(css, /\.skills-source-tab/, v.tag + ': 缺二级源 tab 样式');
    assert.match(css, /\.skills-source-tab\.active[^}]*var\(--accent-light\)/,
      v.tag + ': 二级源激活态应走 --accent-light 主题令牌');
  });
});

test('⑩ 连接器 MCP 市场配色全部走真实主题令牌（不得用假变量或硬编码亮蓝）', () => {
  VARIANTS.forEach(v => {
    const raw = read(path.join(v.base, 'css', 'mcp-market.css'));
    /* 所有检测都必须在【剥离注释后的 CSS】上进行：本文件头注释会复述历史根因
     * （提到 --accent-color / #3b7cff 等），对整份文件做子串检测会被注释骗出假红 ——
     * 这是「检测正则被注释骗」的典型形态。同时只认实际 var() 用法，且 --bg-input
     * 是合法 --bg-input-box 的前缀，必须带 ) 或 , 边界才算命中。 */
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    ['--accent-color', '--bg-input', '--bg-subtle'].forEach(fake => {
      const use = new RegExp('var\\(\\s*' + fake.replace(/-/g, '\\-') + '\\s*[,\\)]');
      assert.ok(!use.test(css), v.tag + ': 用到了不存在的主题变量 ' + fake +
        '（会落回硬编码亮蓝 / 死白，与主题脱节）');
    });
    // 不得残留硬编码品牌蓝 / 死白
    assert.ok(!/#3b7cff/i.test(css), v.tag + ': 残留硬编码亮蓝 #3b7cff');
    assert.ok(!/background:\s*#fff\b/i.test(css), v.tag + ': 残留死白背景 #fff');
    // 关键控件必须用主题令牌
    ['--accent', '--accent-contrast', '--accent-hover', '--accent-light',
      '--bg-input-box', '--bg-card', '--bg-code-block', '--color-success',
      '--text-primary', '--text-secondary', '--text-tertiary', '--border-color']
      .forEach(tok => assert.ok(css.includes('var(' + tok), v.tag + ': 未使用真实令牌 ' + tok));
    /* 搜索框已上移技能页顶栏（唯一真源，2026-11 排版重构）：
     * 底色契约改锁 skills.css 的顶栏输入框；市场壳内搜索框不得复活。
     * env 表单输入框仍须 --bg-input-box（弹窗内唯一的输入控件）。 */
    const skillsCss = read(path.join(v.base, 'css', 'skills.css'));
    assert.match(skillsCss, /\.skills-search-input-wrap input\s*\{[^}]*var\(--bg-primary\)/,
      v.tag + ': 顶栏搜索框底色应走主题令牌（随主题切换）');
    assert.ok(!/\.mcp-market-search\s*\{/.test(css),
      v.tag + ': 壳内搜索框样式复活（搜索框唯一真源在顶栏）');
    assert.match(css, /\.mcp-market-field input\s*\{[^}]*var\(--bg-input-box\)/,
      v.tag + ': env 表单输入框底色应为 --bg-input-box');
    assert.match(css, /\.mcp-market-install-btn\s*\{[^}]*var\(--accent\)[^}]*var\(--accent-contrast\)/,
      v.tag + ': 安装按钮应为 accent 底 + accent-contrast 文字');
    /* 2026-11 官方仓库轮：分类 chip 与技能分类栏**同类名同样式**（用户拍板
     * 「分类切换的样式按照技能的统一」）。市场 CSS 不得再另画一套 chip；
     * 激活态唯一真源 = skills.css 的 .skills-category-chip.active。 */
    assert.ok(!/\.mcp-market-chip/.test(css),
      v.tag + ': 市场 CSS 残留独立 chip 样式（必须与技能分类栏统一为 .skills-category-chip）');
    assert.match(skillsCss, /\.skills-category-chip\.active/,
      v.tag + ': 技能分类 chip 激活态样式缺失（统一样式的唯一真源）');
    /* 目录源 tabs 已退役（只剩魔搭一个源）：样式与厂商命令行连接器样式都不得残留死规则 */
    assert.ok(!/\.mcp-market-source-tab/.test(css),
      v.tag + ': 目录源 tabs 样式已退役，不得残留');
    assert.ok(!/\.mcp-market-cli-|\.mcp-cli-progress/.test(css),
      v.tag + ': 厂商命令行连接器样式已随官方源下线，不得残留死规则');
  });
});

test('⑪ 详情弹窗是 skills.html 的持久节点，市场模块不得再动态生成', () => {
  VARIANTS.forEach(v => {
    const html = read(path.join(v.base, 'skills.html'));
    assert.match(html, /<div class="mcp-market-modal" id="mcpMarketDetail"[^>]*style="display:none"/,
      v.tag + ': 缺持久详情弹窗节点（应位于 .skills-view 下、滚动区外）');
    // 必须在 #skillDetailOverlay 之后（同级，滚动区外）
    assert.ok(html.indexOf('id="mcpMarketDetail"') > html.indexOf('id="skillDetailOverlay"'),
      v.tag + ': MCP 弹窗应与技能详情弹窗同级（.skills-view 直接子元素）');
    // 全文件恰好一个 id（防止双 ID 冲突）
    assert.equal((html.match(/id="mcpMarketDetail"/g) || []).length, 1,
      v.tag + ': mcpMarketDetail 出现多次（双 ID 会让 getElementById 命中不确定）');
    const js = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.ok(!/id="mcpMarketDetail"/.test(js),
      v.tag + ': 市场模块不得再生成弹窗节点（render() 会把正在显示的弹窗冲掉）');
    assert.match(js, /function bindModalOnce\(/,
      v.tag + ': 持久弹窗的委托监听必须一次性绑定（否则 render() 累积监听器）');
    assert.match(js, /e\.key !== 'Escape'|e\.key === 'Escape'/,
      v.tag + ': 弹窗应支持 Escape 关闭');
  });
});

test('⑫ 详情 readme 本地化 + 安全渲染（不得 <pre> 原样输出或 slice 截断）', () => {
  VARIANTS.forEach(v => {
    const js = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.match(js, /function pickReadme\(/, v.tag + ': 缺 readme 本地化选取（实测中文正文在 locales.zh.readme）');
    assert.ok(/locales[\s\S]{0,120}\.readme/.test(js), v.tag + ': 未从 locales 取本地化 readme');
    assert.match(js, /function renderReadme\(/, v.tag + ': 缺轻量 Markdown 渲染');
    // 上游 readme 含大量 HTML table，必须先剥离标签再 esc，否则显示一堆标签源码
    assert.match(js, /replace\(\/<\[\^>\]\*>\/g/, v.tag + ': 未剥离上游 HTML 标签');
    // 链接仅放行 http(s)，防 javascript:/data: 注入
    assert.match(js, /https\?:\\\/\\\//, v.tag + ': 链接渲染未限制 http(s) 协议');
    assert.ok(!/<pre class="mcp-market-readme">/.test(js),
      v.tag + ': 仍把 Markdown 原文塞进 <pre>（用户报详情显示有问题）');
    assert.ok(!/\.slice\(0,\s*1200\)/.test(js),
      v.tag + ': 仍把 readme 截断 1200 字（会截出半截 HTML table 标签）');
  });
});

/* ===== ⑬ 并发代际守卫：P0「搜索失效 + 内容加载不出来」回归护栏 =====
 *
 * 旧版 load() 开头 `if (!state.root || state.loading) return` 会在首屏请求在飞时
 * **静默吞掉** search()/翻页/切分类：请求根本不发出、不渲染、不报错。用户在慢网络
 * 或上游挂起时看到的就是「搜索没反应 + 内容一直空」。switchView(connectors) 里
 * showPane() 可能先调 search(q)、随后又调 load()，天然制造这种并发。
 *
 * vm 实测（真实源码）：修复前并发只发 1 个 servers 请求，修复后发 2 个。
 * 这里用可控 pending fetch 精确复现，并断言旧响应不得覆盖新结果。
 */
test('⑬ 并发 load 不吞请求，且旧响应不得覆盖新结果', async () => {
  function mkEl(id) {
    return {
      id, _ls: {}, _html: '', value: '', style: {}, attrs: {}, textContent: '',
      addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
      listenerCount(t) { return (this._ls[t] || []).length; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      classList: { toggle() {} }, querySelectorAll() { return []; },
      querySelector() { return null; }, closest() { return null; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    };
  }
  function parseIds(html, els) {
    const re = /id="([^"]+)"/g; let m;
    while ((m = re.exec(html))) els[m[1]] = mkEl(m[1]);
  }
  const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });

  for (const base of [UI, ST]) {
    const tag = base === UI ? 'desktop' : 'static';
    const calls = [];
    const pending = [];
    const els = {};
    let renderCount = 0;   // root.innerHTML 被赋值次数 = render() 次数
    const root = mkEl('mcpMarketRoot');
    Object.defineProperty(root, 'innerHTML', {
      get() { return this._html; },
      set(v) { renderCount++; this._html = v; parseIds(v, els); },
    });
    els['mcpMarketRoot'] = root;
    els['mcpMarketDetail'] = mkEl('mcpMarketDetail');

    const sandbox = {
      console, setTimeout, clearTimeout, URLSearchParams,
      document: {
        getElementById: id => els[id] || null,
        querySelector: sel => (sel === '#mcpMarketRoot' ? root : null),
        addEventListener() {},
      },
      window: { addEventListener() {}, showToast() {}, GourdI18n: null },
      fetch: url => {
        if (/market\/install|market\/detail|market\/categories/.test(url)) {
          const d = /categories/.test(url) ? [{ key: '', nameZh: '全部', name: 'All' }] : {};
          return Promise.resolve(ok(d));
        }
        if (/market\/servers/.test(url)) {
          calls.push(url);
          return new Promise(resolve => pending.push(resolve));  // 两个请求都可控挂起
        }
        return Promise.resolve(ok({}));
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read(path.join(base, 'js', 'app-mcp-market.js')), sandbox, { filename: 'app-mcp-market.js' });
    const market = sandbox.window._mcpMarket;
    market.setHost('#mcpMarketRoot');

    // 首屏 refresh()（无关键词）+ 紧接 search('amap')：旧布尔锁会吞掉第二次
    const pA = market.refresh();
    const pB = market.search('amap');
    await Promise.resolve();   // 让两个 async 都走到 fetch

    assert.equal(calls.length, 2,
      tag + ': 并发只发出 ' + calls.length + ' 个请求 —— state.loading 布尔锁又回来了？' +
      '首屏在飞时搜索/翻页/切分类会被静默吞掉（搜索失效 + 内容加载不出来）');
    assert.ok(!/search=/.test(calls[0]), tag + ': 首个请求应为无关键词首屏');
    assert.match(calls[1], /search=amap/, tag + ': 第二个请求必须带搜索关键词');

    // 新请求 B 先返回：应渲染（render 计数 +1），且 NEW 卡片真的写进 grid
    pending[1](ok({ total_count: 1, mcp_server_list: [{ id: '@new/NEW', name: 'NEW' }] }));
    await pB;
    assert.equal(renderCount, 1, tag + ': 最新请求返回后必须渲染一次');
    const gridAfterNew = els['mcpMarketGrid'] ? els['mcpMarketGrid'].innerHTML : '';
    assert.match(gridAfterNew, /NEW/,
      tag + ': 最新请求的数据没有渲染成卡片（只数 render 次数会漏掉「渲染了空壳」）');

    // 旧请求 A 后返回：代际守卫必须丢弃，不得再渲染、不得清掉新结果
    const countBeforeOld = renderCount;
    pending[0](ok({ total_count: 999, mcp_server_list: [{ id: '@old/OLD', name: 'OLD' }] }));
    await pA;
    assert.equal(renderCount, countBeforeOld,
      tag + ': 过期响应触发了 render，会把慢旧请求覆盖到新搜索结果上（代际守卫失效）');
    const gridAfterOld = els['mcpMarketGrid'] ? els['mcpMarketGrid'].innerHTML : '';
    assert.ok(/NEW/.test(gridAfterOld) && !/OLD/.test(gridAfterOld),
      tag + ': 慢旧请求把 OLD 覆盖到了新搜索结果上（内容级代际守卫必须拦住）');
  }
});

test('⑭ 不得回退成布尔锁 state.loading（静态形状锁）', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    /* 精确锁旧布尔锁字段 state.loading（词边界）：无限滚动的 state.appending
     * 是另一语义（追加在途标记，loadMore 内部防重入），不得误伤。 */
    assert.ok(!/if\s*\([^)]*state\.loading\b[^)]*\)\s*return/.test(s),
      v.tag + ': load() 又用 state.loading 静默吞并发请求');
    assert.match(s, /loadSeq/, v.tag + ': 缺并发代际序号');
    assert.match(s, /if\s*\(seq !== state\.loadSeq\)\s*return/,
      v.tag + ': 缺过期响应丢弃守卫');
  });
});

/* ===== ⑮ 顶栏搜索框不得跨视图复用（P1「幽灵过滤」+ P2「双搜索框」回归护栏）=====
 *
 * 旧版 showPane 在连接器页把顶栏 #skillsSearchInput 改占位符「复用为 MCP 搜索」，
 * 并把它的当前值当作市场查询词。两个缺陷：
 *   ① 市场模块 shell() 自带 #mcpMarketSearch → 同屏两个搜索框，状态互不同步；
 *   ② switchView 里 showPane(view) 先于 $skillsSearchInput.val('') 执行，
 *      「技能市场搜 foo → 点连接器」会把 foo 静默带成 MCP 过滤词，随后顶栏框被清空
 *      → 搜索框空白、列表却是被 foo 过滤的空态，用户无从察觉也无从自救。
 * 修法：顶栏搜索框在连接器/接口页一律隐藏，市场只保留自己那一个搜索框。
 */
test('⑮ 搜索框唯一真源在顶栏：壳内第二搜索框不得复活，查询词不得跨视图携带', () => {
  VARIANTS.forEach(v => {
    /* 所有子串检测都在【剥离注释后】的源码上做：本轮修复的说明注释里会复述
     * PLACEHOLDER_MCP / _mcpMarket.search 等旧写法，对整份文件检测会被注释骗出假红。 */
    const src = read(path.join(v.base, 'js', 'app-skills.js')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    // (a) 跨视图改写占位符的机制必须彻底消失（否则又变成「一个框两种语义」）
    assert.ok(!/PLACEHOLDER_SKILLS\s*=/.test(src),
      v.tag + ': 仍在按视图改写顶栏搜索框占位符（连接器页曾把它复用为 MCP 搜索）');
    assert.ok(!/PLACEHOLDER_MCP\s*=/.test(src), v.tag + ': 同上，PLACEHOLDER_MCP 未清除');

    // (b) showPane 不得把顶栏搜索框的值当成市场查询词 —— 这就是幽灵过滤的来源。
    //     注意判据要精确对准缺陷形状：`$skillsSearchInput.val()` 在
    //     `$skillsSearchClear.toggle(isSkills && !!(...).trim())` 里是**合法**用法
    //     （决定 × 清除按钮显隐，与查询无关）。一刀切禁止 .val() 会误报，
    //     把「有清除按钮」的正常实现也拦死 —— 护栏过严同样是缺陷。
    const paneFn = /function showPane\(view\)\s*\{([\s\S]*?)\n    \}/.exec(src);
    assert.ok(paneFn, v.tag + ': 无法定位 showPane 函数体');
    const pane = paneFn[1];
    assert.ok(!/_mcpMarket\.search/.test(pane),
      v.tag + ': showPane 仍在用顶栏搜索框驱动市场查询，跨模块耦合回来了');
    const valUses = pane.split('\n').filter(l => /\$skillsSearchInput\.val\(\)/.test(l));
    valUses.forEach(l => assert.match(l, /\$skillsSearchClear\.toggle\(/,
      v.tag + ': showPane 里读取顶栏搜索框的值只能用于决定 × 按钮显隐，' +
      '不得作为市场查询词（switchView 里 showPane 先于 val(\'\') 执行，' +
      '会把上一个视图的搜索词静默带成 MCP 过滤条件）。实际行: ' + l.trim()));
    assert.ok(!/var\s+\w+\s*=\s*\(\$skillsSearchInput\.val\(\)/.test(pane),
      v.tag + ': 仍把顶栏搜索框的值取进局部变量待用作查询词');
    assert.ok(/setHost\('#mcpMarketRoot'\)/.test(pane),
      v.tag + ': 连接器页仍须把市场宿主指向 #mcpMarketRoot');

    // (c) 必须 toggle 整个 .skills-search-input-wrap：放大镜图标是 wrap 内的
    //     position:absolute 子元素，wrap 自身还是 flex:1 1 auto / min-width:180px，
    //     只藏 input 会留下悬空图标 + 180px 空白占位（接口页曾就是这个形态）。
    assert.ok(/\$skillsSearchWrap\s*=\s*\$skillsSearchInput\.closest\('\.skills-search-input-wrap'\)/.test(src),
      v.tag + ': 缺 $skillsSearchWrap（应从 input 向上取 .skills-search-input-wrap）');
    assert.match(pane, /\$skillsSearchWrap\.toggle\(isSkills\)/,
      v.tag + ': 技能视图的搜索框显隐仍须整体 toggle wrap（含放大镜图标）');
    assert.ok(!/\$skillsSearchInput\.toggle\(/.test(pane),
      v.tag + ': 只 toggle input 会留下悬空放大镜图标与 180px 空白占位');

    /* (d) 2026-11 排版重构后的新契约：连接器广场的搜索【就是】顶栏这一个框
     * （市场壳内 #mcpMarketSearch 已删除，双框状态不同步的旧缺陷被结构性消灭）。
     * 因此锁三点：
     *   1. 市场模块不得再渲染第二搜索框（id/类名都不得复活）；
     *   2. 顶栏搜索事件必须有连接器广场分支（否则广场搜不了）；
     *   3. 查询词不得跨视图携带：switchView 与 switchConnView 都必须清值。 */
    const mkt = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.ok(!/id="mcpMarketSearch"/.test(mkt),
      v.tag + ': 市场壳内第二搜索框复活（同屏双框、状态互不同步的旧缺陷回来了）');
    assert.ok(!/mcp-market-search/.test(mkt),
      v.tag + ': 壳内搜索框类名复活');
    assert.match(src, /_currentView === VIEW_CONNECTORS[\s\S]{0,200}_mcpMarket\.search/,
      v.tag + ': 顶栏搜索事件缺连接器广场分支（广场唯一搜索入口失效）');
    const connFn = /function switchConnView\(view\)\s*\{([\s\S]*?)\n    \}/.exec(src);
    assert.ok(connFn, v.tag + ': 无法定位 switchConnView 函数体');
    assert.match(connFn[1], /\$skillsSearchInput\.val\(''\)/,
      v.tag + ': 连接器二级视图切换不清搜索值（幽灵过滤会跨「已安装/广场」携带）');
  });
});

/* ===== ⑯ render() 必须恢复搜索框焦点（P2「打字无反应」）=====
 *
 * shell() 把 #mcpMarketSearch 一起画出来，而 render() 是整块 innerHTML 替换。
 * 用户输入触发 350ms 防抖 → load() → render() → 输入框被销毁重建 → 焦点掉到 body，
 * 用户接着打字毫无反应，必须重新点进框；光标位置也丢。
 * 这里用 vm 跑真实源码：先渲染拿到输入框、置为 activeElement，再触发第二次 render，
 * 断言焦点与 caret 落到了**新的**那个节点上。
 */
test('⑯ 搜索框是持久顶栏节点：render 不得重建/抢占它（焦点丢失缺陷的结构性修复）', async () => {
  function mkEl(id) {
    return {
      id, _ls: {}, _html: '', value: '', style: {}, attrs: {}, textContent: '',
      focusCalls: 0, caretSet: null, selectionStart: 0, disabled: false,
      focus() { this.focusCalls++; },
      setSelectionRange(a) { this.caretSet = a; },
      addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
      setAttribute(k, val) { this.attrs[k] = val; }, getAttribute(k) { return this.attrs[k]; },
      classList: { toggle() {} }, querySelectorAll() { return []; },
      querySelector() { return null; }, closest() { return null; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    };
  }
  const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });

  for (const base of [UI, ST]) {
    const tag = base === UI ? 'desktop' : 'static';
    const els = {};
    const root = mkEl('mcpMarketRoot');
    Object.defineProperty(root, 'innerHTML', {
      get() { return this._html; },
      set(v) {
        this._html = v;
        const re = /id="([^"]+)"/g; let m;
        while ((m = re.exec(v))) els[m[1]] = mkEl(m[1]);   // 每次 render 都换新节点
      },
    });
    els['mcpMarketRoot'] = root;
    els['mcpMarketDetail'] = mkEl('mcpMarketDetail');

    const sandbox = {
      console, setTimeout, clearTimeout, URLSearchParams,
      document: {
        activeElement: null,
        getElementById: id => els[id] || null,
        querySelector: sel => (sel === '#mcpMarketRoot' ? root : null),
        addEventListener() {},
      },
      window: { addEventListener() {}, showToast() {}, GourdI18n: null },
      fetch: url => {
        if (/market\/categories/.test(url)) return Promise.resolve(ok([
          { key: '', nameZh: '全部', name: 'All' },
          { key: 'search', nameZh: '搜索', name: 'Search' },
        ]));
        if (/market\/servers/.test(url)) {
          return Promise.resolve(ok({ total_count: 1, mcp_server_list: [{ id: '@a/b', name: 'B' }] }));
        }
        return Promise.resolve(ok({}));
      },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read(path.join(base, 'js', 'app-mcp-market.js')), sandbox, { filename: 'app-mcp-market.js' });
    const market = sandbox.window._mcpMarket;
    market.setHost('#mcpMarketRoot');

    /* 头部筛选宿主是 skills.html 静态持久节点：首次 render 前就位（与真实 DOM 一致）。 */
    const headBar = mkEl('mcpMarketCatBar');
    els['mcpMarketCatBar'] = headBar;
    await market.load();   // 对外 load 会先拉 categories（refresh 只重查列表）
    /* 壳内不得再有任何输入框：搜索唯一真源在持久顶栏（#skillsSearchInput），
     * render() 整块 innerHTML 替换只发生在 #mcpMarketRoot 目录区，
     * 顶栏输入框根本不在替换范围内——焦点/光标丢失缺陷被结构性消灭。 */
    assert.ok(!els['mcpMarketSearch'],
      tag + ': 市场壳内又渲染出搜索框（render 重建 → 焦点掉 body 的旧缺陷回来了）');
    assert.ok(!/mcpMarketSearch/.test(root.innerHTML),
      tag + ': root.innerHTML 含搜索框节点');
    /* 头部宿主不得被 render 冲掉：chips 由 shell 回填 innerHTML，
     * 宿主自身与其监听器必须常驻（bindHeadOnce 记忆化）。 */
    await market.refresh();
    assert.equal((headBar._ls.click || []).length, 1,
      tag + ': 头部 chips 宿主委托监听器累积（bindHeadOnce 记忆化失效）');
    assert.match(headBar.innerHTML, /skills-category-chip/,
      tag + ': 分类 chips 未回填到头部持久宿主（且必须与技能分类栏同类名）');
  }
});

/* ===== ⑰~㉑ 2026-11 codereview 修复轮的回归护栏 =====
 *
 * 上一轮交付时我只做了「数量断言」（示例区恰好 2 条），结果 P0 级虚假内容
 * （把「需要 Python 3.10」「uv >= 0.1.30」「本项目采用 MIT 许可证开源」
 * 当成「试试这样用」示例）在 16 条契约测试全绿的情况下活了下来。
 * 教训：数量断言对语义失真恒真。以下护栏一律断言**内容与结构**，
 * 并且都跑真实模块源码（vm），不是读文本匹配。
 */

/** 最小 DOM stub + 可控 fetch，供 ⑰~㉑ 复用。detailOf/fetchImpl 由用例注入。 */
function mkMarketSandbox(opts) {
  const base = opts.base;
  const els = {};
  function mkEl(id) {
    return {
      id, _ls: {}, _html: '', value: '', style: {}, attrs: {}, textContent: '',
      addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      classList: { toggle() {} },
      /* collectEnv 会对 [data-env] 结果 .forEach，必须返回数组而不是 null */
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
  }
  const root = mkEl('mcpMarketRoot');
  els['mcpMarketRoot'] = root;
  els['mcpMarketDetail'] = mkEl('mcpMarketDetail');
  const toasts = [];
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    document: {
      activeElement: null,
      getElementById: id => els[id] || null,
      querySelector: sel => (sel === '#mcpMarketRoot' ? root : null),
      addEventListener() {},
    },
    window: { addEventListener() {}, showToast: (m, t) => toasts.push({ m, t }), GourdI18n: null },
  };
  sandbox.fetch = opts.fetch;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(path.join(base, 'js', 'app-mcp-market.js')), sandbox, { filename: 'app-mcp-market.js' });
  return { sandbox, root, modal: els['mcpMarketDetail'], els, toasts, market: sandbox.window._mcpMarket };
}

/** 上游真实形态的 readme：开头几行列表项就是环境要求与许可证（P0 的触发语料） */
const REALISTIC_README = [
  '# 飞书 MCP Server',
  '',
  '## Requirements',
  '',
  '- 需要 Python 3.10 或更高版本才能运行本服务',
  '- uv >= 0.1.30',
  '- 本项目采用 MIT 许可证开源',
  '- 安装完成后请重启客户端以生效',
  '',
  '## 安装步骤',
  '',
  '1. 安装 uv 包管理器',
  '2. 克隆仓库到本地',
  '3. 执行 uvx feishu-mcp 启动',
  '',
  '详见 [官方文档](https://example.com/doc)。',
].join('\n');

test('⑰ 详情弹窗不得出现「试试这样用」示例区（P0 虚假内容防复活）', async () => {
  for (const v of VARIANTS) {
    const src = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    // (a) 提炼函数与容器类名必须彻底不存在：留一半就是「看着砍了、实际还能跑」
    assert.ok(!/pickPrompts/.test(src), v.tag + ': pickPrompts 已按用户拍板删除，不得复活');
    assert.ok(!/mcp-market-prompt/.test(src), v.tag + ': 示例区 DOM 类名不得复活');
    // (b) 真实语料渲染：即使 readme 开头全是环境要求，也不得被摆进任何「示例」容器
    const h = mkMarketSandbox({
      base: v.base,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({ code: 200, data: { name: '飞书', description: 'd', env_schema: { properties: {}, required: [] }, readme: REALISTIC_README } }),
      }),
    });
    await h.market.showDetail('p0-case');
    const html = h.modal.innerHTML;
    assert.ok(!/mcp-market-prompts|试试这样用/.test(html), v.tag + ': 渲染结果仍含示例区');
    /* (c) 关键的反向断言：readme 里的环境要求**必须仍然出现**（在 readme 区正常显示），
     * 只是不能出现在「示例」语义容器里。若有人为了过 (b) 把 readme 整个砍掉，
     * 这条会失败——防止用「删内容」来蒙混过关。 */
    assert.ok(html.includes('需要 Python 3.10'), v.tag + ': readme 正文丢失（不是砍示例区，是砍了 readme）');
    assert.ok(/mcp-market-readme/.test(html), v.tag + ': readme 容器缺失');
    const css = read(path.join(v.base, 'css', 'mcp-market.css'));
    assert.ok(!/mcp-market-prompts?[^-]/.test(css), v.tag + ': CSS 仍留示例区死规则');
  }
});

test('⑱ showDetail 必须有代际守卫：慢的旧响应不得覆盖用户正在看的新详情', async () => {
  for (const v of VARIANTS) {
    const src = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    assert.match(src, /detailSeq/, v.tag + ': 缺 detailSeq 代际号（与 loadSeq 同口径）');
    // 守卫必须在 await 之后生效，且要同时挡住「过期的成功」与「过期的失败」
    assert.ok((src.match(/seq !== state\.detailSeq/g) || []).length >= 2,
      v.tag + ': 过期响应丢弃点不足 2 处（成功分支 + 失败分支都要挡）');

    const delays = { slow: 60, fast: 1 };
    const h = mkMarketSandbox({
      base: v.base,
      fetch: async (url) => {
        const id = /id=([^&]+)/.exec(String(url))[1];
        await new Promise(r => setTimeout(r, id === 'SLOW' ? delays.slow : delays.fast));
        return {
          ok: true, status: 200,
          json: async () => ({ code: 200, data: { name: 'NAME-' + id, description: 'd', env_schema: { properties: {}, required: [] }, readme: '' } }),
        };
      },
    });
    // 用户先点 SLOW，再点 FAST：最终必须停在 FAST
    const p1 = h.market.showDetail('SLOW');
    const p2 = h.market.showDetail('FAST');
    await Promise.all([p1, p2]);
    await new Promise(r => setTimeout(r, delays.slow + 30));
    const html = h.modal.innerHTML;
    assert.ok(html.includes('NAME-FAST'), v.tag + ': 弹窗最终显示的不是用户最后点的服务（竞态未修）');
    assert.ok(!html.includes('NAME-SLOW'), v.tag + ': 慢的旧响应把弹窗改回了上一个服务');
    assert.equal(h.modal.getAttribute('data-current'), 'FAST',
      v.tag + ': data-current 停留在旧 id，点「连接」会装错服务');

    // 过期的**失败**同样不得覆盖用户正在看的成功详情
    const h2 = mkMarketSandbox({
      base: v.base,
      fetch: async (url) => {
        const id = /id=([^&]+)/.exec(String(url))[1];
        if (id === 'FAILSLOW') {
          await new Promise(r => setTimeout(r, 60));
          return { ok: false, status: 500, json: async () => ({ code: 500, description: '上游超时' }) };
        }
        return {
          ok: true, status: 200,
          json: async () => ({ code: 200, data: { name: 'OKFAST', description: 'd', env_schema: { properties: {}, required: [] }, readme: '' } }),
        };
      },
    });
    const q1 = h2.market.showDetail('FAILSLOW');
    const q2 = h2.market.showDetail('OKID');
    await Promise.all([q1, q2]);
    await new Promise(r => setTimeout(r, 90));
    assert.ok(h2.modal.innerHTML.includes('OKFAST'), v.tag + ': 过期的失败响应盖掉了用户正在看的详情');
    assert.ok(!h2.modal.innerHTML.includes('上游超时'), v.tag + ': 过期失败仍写入弹窗');
  }
});

test('⑲ env 表单可显示判据必须由内核给出，前端不得复刻 http 别名表', async () => {
  for (const v of VARIANTS) {
    const src = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    // (a) 前端只读后端注入的标志
    assert.match(src, /env_supported/, v.tag + ': 前端未读 env_supported 标志');
    // (b) 前端绝不能自己判 http 类型：复刻别名表必然漏（历史上就漏过 remote/ssehttp）
    assert.ok(!/streamable_stateless|ssehttp|streamablehttp/.test(src),
      v.tag + ': 前端复刻了 http 别名表，判据不再与内核同源');
  }
  // (c) 后端两个真源都必须存在且调用同一个 http 判定
  const rs = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'mcp_market_api.rs'));
  assert.match(rs, /pub fn env_supported/, 'Rust 缺 env_supported');
  assert.match(rs, /env_supported/, 'detail 接口未注入 env_supported');
  assert.match(rs, /crate::mcp::is_http_type/, 'env_supported 必须复用 mcp::is_http_type 这一唯一真源');
  const jn = read(path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'market', 'impl', 'McpMarketConfigNormalizer.java'));
  assert.match(jn, /public static boolean envSupported/, 'Java 缺 envSupported');
  assert.match(jn, /McpTypeResolver\.isHttpType/, 'envSupported 必须复用 McpTypeResolver.isHttpType');
  const jm = read(path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'market', 'impl', 'ModelscopeMcpMarket.java'));
  assert.match(jm, /env_supported/, 'Java detail 接口未注入 env_supported');
  /* (d) 行为验证：http 型服务（后端标 env_supported=false）即便 env_schema 有字段，
   * 也不得渲染表单 —— 否则用户填的值会被 normalize 的 http 分支静默丢弃，
   * 却仍提示「安装成功」（P1-2 的事故链）。 */
  for (const v of VARIANTS) {
    const h = mkMarketSandbox({
      base: v.base,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({
          code: 200,
          data: {
            name: 'SSE服务', description: 'd', env_supported: false,
            env_schema: { properties: { API_TOKEN: { description: 'token' } }, required: [] }, readme: '',
            server_config: [{ mcpServers: { s: { type: 'sse', url: 'https://x/sse' } } }],
          },
        }),
      }),
    });
    await h.market.showDetail('http-case');
    const html = h.modal.innerHTML;
    assert.ok(!/mcp-market-env"/.test(html), v.tag + ': http 型服务仍渲染 env 表单，密钥会被静默丢弃');
    assert.ok(!/data-env=/.test(html), v.tag + ': http 型服务仍有 env 输入框');
    assert.ok(!/save_connect|保存并连接/.test(html), v.tag + ': 无表单时页脚应为「连接」而非「保存并连接」');
    assert.ok(/data-confirm/.test(html), v.tag + ': 连接按钮缺失');
  }
  /* (e) stdio 服务不受影响：必须照常渲染三段式表单（变量名 + 红星 + 描述 + 输入框）。
   * 缺 env_supported 字段时也要按 true 处理，兼容未升级的老内核。 */
  for (const v of VARIANTS) {
    const h = mkMarketSandbox({
      base: v.base,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({
          code: 200,
          data: {
            name: 'Stdio服务', description: 'd',
            env_schema: { properties: { APP_ID: { description: '应用 ID' } }, required: ['APP_ID'] }, readme: '',
          },
        }),
      }),
    });
    await h.market.showDetail('stdio-case');
    const html = h.modal.innerHTML;
    assert.ok(/mcp-market-env"/.test(html), v.tag + ': stdio 服务的 env 表单被误杀');
    assert.ok(/data-env="APP_ID"/.test(html), v.tag + ': env 输入框缺失');
    assert.ok(/mcp-market-field-req/.test(html), v.tag + ': 必填红星缺失');
    assert.ok(html.includes('应用 ID'), v.tag + ': 字段描述行缺失');
    assert.ok(/保存并连接/.test(html), v.tag + ': 有表单时页脚应为「保存并连接」');
  }
});

test('⑳ 详情失败必须是同骨架错误卡（可关闭可重试），不得是裸文字浮层', async () => {
  for (const v of VARIANTS) {
    const h = mkMarketSandbox({
      base: v.base,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({ code: 503, description: '上游超时' }) }),
    });
    await h.market.showDetail('err-case');
    const html = h.modal.innerHTML;
    assert.ok(/mcp-market-modal-close/.test(html), v.tag + ': 错误态无关闭按钮');
    assert.ok(/data-close/.test(html), v.tag + ': 错误态关闭按钮无 data-close，点不动');
    assert.ok(/data-retry/.test(html), v.tag + ': 错误态无重试入口');
    assert.ok(/重试|Retry/.test(html), v.tag + ': 重试按钮无文案');
    assert.ok(html.includes('上游超时'), v.tag + ': 真实错误原因丢失');
    assert.ok(/mcp-market-err-/.test(html), v.tag + ': 错误态无专属样式类，会是光秃秃一块文字');
    assert.ok(/mcp-market-modal-box/.test(html), v.tag + ': 错误态未复用正常态骨架');
    // 错误文案必须走 i18n，不能是硬编码中文串（GourdI18n 为 null 时才回落中文兜底）
    const css = read(path.join(v.base, 'css', 'mcp-market.css'));
    ['mcp-market-err-body', 'mcp-market-err-icon', 'mcp-market-err-text'].forEach(c =>
      assert.ok(css.includes(c), v.tag + ': CSS 缺 ' + c + '，错误态没有排版'));
    assert.ok(css.includes('mcp-market-modal-loading'), v.tag + ': CSS 缺加载态样式');
  }
});

test('㉑ 卡片安装入口必须与技能卡同形态（+ 号图标按钮），且不得有重复语义的文字按钮', async () => {
  const skillsPlus = /PLUS_SVG = '([^']*(?:'[^']*'[^']*)*)'/;
  const sk = read(path.join(UI, 'js', 'app-skills.js'));
  const skM = /var PLUS_SVG = '([\s\S]*?)';/.exec(sk);
  assert.ok(skM, 'app-skills.js 的 PLUS_SVG 常量找不到，测试前提失效');
  for (const v of VARIANTS) {
    const src = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    /* 行尾必须容忍 CRLF：本仓库 .gitattributes 下这些文件实际是 CRLF，
     * 写死 `;\n` 会让「常量存在」被误判成「常量缺失」（自伤过一次）。 */
    const mkM = /var PLUS_SVG = ([\s\S]*?);\r?\n/.exec(src);
    assert.ok(mkM, v.tag + ': 缺 PLUS_SVG 常量');
    // (a) 图标与技能卡逐字节一致（同 viewBox / 同 stroke-width / 同两条线），
    //     保证同页两种卡片的安装入口视觉同源
    /* 归一化必须同时处理两种写法：技能卡是单行字面量（捕获组不含外层引号），
     * 本模块是多行 ' + ' 拼接（捕获组仍带外层引号）。只剥连接符会让两边永远
     * 差一对引号、误报「形态割裂」——比对的是 SVG 标记本身，不是书写风格。 */
    const norm = s => s.replace(/'\s*\+\s*'/g, '').replace(/^\s*'|'\s*$/g, '')
      .replace(/\s+/g, ' ').trim();
    assert.equal(norm(mkM[1]), norm(skM[1]),
      v.tag + ': + 号 SVG 与技能卡不一致，同页两种卡片形态又开始割裂');
    // (b) 必须走 data-act="install" 委托，且是 mcp-market-card-add 类
    assert.match(src, /mcp-market-card-add/, v.tag + ': 卡片缺 + 号按钮类名');
    assert.ok(!/mcp-market-detail-btn/.test(src), v.tag + ': 「详情」文字按钮已废弃，不得复活（与整卡点击语义重复）');
    assert.ok(!/mcp-market-card-actions/.test(src), v.tag + ': 旧的文字按钮组容器已废弃');
    const css = read(path.join(v.base, 'css', 'mcp-market.css'));
    assert.ok(css.includes('.mcp-market-card-add'), v.tag + ': CSS 缺 + 号按钮样式');
    assert.ok(/\.mcp-market-card-add:hover\s*\{[^}]*--accent/.test(css),
      v.tag + ': + 号按钮 hover 未翻 accent 实底，与技能卡交互不一致');
    // (c) 卡片必须有相对定位，否则右上角绝对定位的 + 号会跑到页面角落
    assert.ok(/\.mcp-market-card\s*\{[^}]*position:\s*relative/.test(css),
      v.tag + ': .mcp-market-card 缺 position:relative，+ 号按钮定位基座丢失');
    // (d) 弹窗页脚主按钮的基础样式必须仍在（旧的共享规则被拆过，漏了会退回浏览器默认灰底）
    assert.ok(/\.mcp-market-install-btn\s*\{[^}]*--accent/.test(css),
      v.tag + ': 弹窗主按钮缺 accent 底色');
    assert.ok(/\.mcp-market-cancel-btn/.test(css), v.tag + ': 取消按钮样式缺失');
    /* (e) 弹窗「连接」主操作唯一在 foot（2026-11 用户报障「连接按钮重复了」）：
     * hero 曾同时渲染 .mcp-market-connect-btn（data-confirm）与 foot 的
     * .mcp-market-install-btn（data-confirm），同屏两个同语义主按钮，且 hero
     * 按钮不感知表单文案（有必填 env 时仍写「连接」）。行为级断言：真实渲染
     * 后 data-confirm 恰好 1 个、且在 foot 里；hero 按钮类名不得复活（JS/CSS）。 */
    assert.ok(!/mcp-market-connect-btn/.test(src),
      v.tag + ': hero「连接」按钮复活（与 foot 主按钮语义重复）');
    /* CSS 判据锁「规则」而非「字符串」：说明注释里会复述类名，整文件子串检测
     * 会被注释骗出假红（与 ⑮ 剥注释同口径）。 */
    assert.ok(!/\.mcp-market-connect-btn\s*[{,:]/.test(css),
      v.tag + ': CSS 残留 hero 连接按钮死规则');
    const hBtn = mkMarketSandbox({
      base: v.base,
      fetch: async () => ({
        ok: true, status: 200,
        json: async () => ({
          code: 200,
          data: {
            name: '按钮唯一性', description: 'd', readme: '',
            env_schema: { properties: { KEY: { description: 'k' } }, required: ['KEY'] },
          },
        }),
      }),
    });
    await hBtn.market.showDetail('btn-case');
    const btnHtml = hBtn.modal.innerHTML;
    assert.equal((btnHtml.match(/data-confirm/g) || []).length, 1,
      v.tag + ': 弹窗 data-confirm 主操作不是恰好 1 个（连接按钮重复/缺失）');
    const footIdx = btnHtml.indexOf('mcp-market-modal-foot');
    assert.ok(footIdx >= 0 && btnHtml.indexOf('data-confirm') > footIdx,
      v.tag + ': 唯一主操作必须在 foot（取消旁），不得回 hero');
  }
});

/* ===== ㉖ 2026-11 codereview 轮回归护栏（行为级，非字符串级） =====
 *
 * 本轮深审抓出的真实缺陷：安装无在途防重（连点 → 「已安装」紧跟「安装失败：重名」）。
 * 字符串断言测不出这类状态机缺陷，这里用 vm 沙箱跑真实模块源码钉行为。
 *
 * （原 ㉕「源切换必须重置分类/滚动并立即同步 tab 态」已随目录源 tabs 退役而删除：
 *   连接器广场只剩魔搭一个目录源，源切换这条路径不复存在，loadMarketWithHead
 *   增强沙箱也只服务于它，一并删除。）
 * （原 ㉗ 中「分类表按源」部分已删除，见下方 ㉗ 保留的徽标/authType 断言。） */

test('㉖ 安装在途防重：连点同一 id 只发一次安装请求（行为级回归护栏）', async () => {
  for (const base of [UI, ST]) {
    const tag = base === UI ? 'desktop' : 'static';
    const ctx = loadMarketModule(tag, path.join(base, 'js', 'app-mcp-market.js'));
    await ctx.market.refresh();
    const fakeBtn = { getAttribute: (k) => (k === 'data-act' ? 'install' : '@a/b'), closest: function (s) { return s === '[data-act]' ? this : null; } };
    // 连点 3 次（install 是异步链，第一发未返回时后两发必须被在途锁挡掉）
    (ctx.root._ls.click || []).forEach(f => f({ target: fakeBtn }));
    (ctx.root._ls.click || []).forEach(f => f({ target: fakeBtn }));
    (ctx.root._ls.click || []).forEach(f => f({ target: fakeBtn }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ctx.installed.length, 1,
      tag + ': 连点 3 次发出 ' + ctx.installed.length + ' 次安装请求（第二发起撞后端重名 400，' +
      '用户看到「已安装」紧跟「安装失败」）');
    // 在途结束后再点一次应可正常发起（锁必须释放，不能永久卡死）
    (ctx.root._ls.click || []).forEach(f => f({ target: fakeBtn }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ctx.installed.length, 2, tag + ': 在途锁未释放，后续安装被永久卡死');
  }
});

test('㉘ 语言包值契约：connect_title 无占位符、zh-TW 授权块无英文残留、双壳字节一致', () => {
  [path.join(UI, 'locales'), path.join(ST, 'locales')].forEach(dir => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    const zhCN = JSON.parse(read(path.join(dir, 'zh-CN.json'))).settings.mcp;
    const zhTW = JSON.parse(read(path.join(dir, 'zh-TW.json'))).settings.mcp;
    const en = JSON.parse(read(path.join(dir, 'en.json'))).settings.mcp;
    files.forEach(f => {
      const mkt = JSON.parse(read(path.join(dir, f))).settings.mcp.market;
      /* m('connect_title','连接') 调用处不传 params：值里出现 {msg} 会直接漏到界面
       * （zh-TW 曾漂移为「連接 {msg}」）。 */
      assert.ok(!String(mkt.connect_title || '').includes('{msg}'),
        dir + '/' + f + ': connect_title 含 {msg} 占位符（调用处不传 params）');
    });
    /* zh-TW.json:526-555 的授权块历史上整段是英文占位。判据：zh-CN 值是中文
     * （含汉字）而 zh-TW 与 en 逐字相同 → 英文残留。含 Access Token / https 等
     * 专有词的键按「汉字存在」判据放行（其余部分应已译）。 */
    const cjk = /[\u3400-\u9fff]/;
    const leftovers = [];
    Object.keys(zhCN).forEach(k => {
      if (typeof zhCN[k] !== 'string') return;          // market 子对象由 ⑥ 单独校验
      if (!cjk.test(zhCN[k])) return;                   // 简体本身是术语，跳过
      if (String(zhTW[k]) === String(en[k]) && !cjk.test(String(zhTW[k]))) {
        leftovers.push(k + ' = ' + zhTW[k]);
      }
    });
    assert.deepStrictEqual(leftovers, [], dir + '/zh-TW.json: settings.mcp 授权块仍有英文残留');
    /* 双壳语言包必须字节一致：两壳同份资源，漂移等于运行时界面不一致。 */
    const other = dir.includes('desktop' + path.sep + 'ui')
      ? path.join(ST, 'locales') : path.join(UI, 'locales');
    files.forEach(f => {
      const a = fs.readFileSync(path.join(dir, f));
      const b = fs.readFileSync(path.join(other, f));
      assert.ok(a.equals(b), f + ': 双壳语言包字节不一致');
    });
  });
});

/* ===== ㉙ 空目录空态（P1 观感回归） =====
 *
 * 原 ㉙「admin 软失败(registry_error) 时空态必须可重试」已随自建官方源下线而删除：
 * registry_error 是官方远程目录专用的软失败信号（HTTP 200 + 空列表 + 失败原因），
 * 连接器广场只剩魔搭一个源后不存在这条路径，前端消费代码与可重试空态一并退役。
 * 保留「空目录 = 未找到」这一侧的行为断言，并反向钉死软失败专用空态不得复活。
 *
 * 用 vm 沙箱加载真实模块 + 最小 DOM，断言空目录渲染「未找到 MCP 服务」。
 */
function loadMarketModuleEmpty(file, serversPayload) {
  const byId = {};
  const mk = (id) => (byId[id] = byId[id] || Object.assign(makeEl(id), {
    textContent: '', className: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
  }));
  mk('mcpMarketRoot'); mk('mcpMarketGrid'); mk('mcpMarketCatBar');
  mk('mcpMarketTotal'); mk('mcpMarketSentinel');
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    document: {
      getElementById: (id) => byId[id] || null,
      querySelector: (sel) => (sel === '#mcpMarketRoot' ? byId.mcpMarketRoot : null),
      addEventListener() {},
    },
    window: { addEventListener() {}, showToast() {}, GourdI18n: null },
    fetch: async (url) => {
      if (/market\/categories/.test(url)) return { ok: true, status: 200, json: async () => ({ code: 200, data: [] }) };
      return { ok: true, status: 200, json: async () => serversPayload };
    },
    Element: function () {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(file), sandbox, { filename: file });
  const market = sandbox.window._mcpMarket;
  market.setHost('#mcpMarketRoot');
  return { market, grid: byId.mcpMarketGrid };
}

test('㉙ 空目录空态显示「未找到」，官方源专用的可重试软失败空态不得复活', async () => {
  for (const v of VARIANTS) {
    const file = path.join(v.base, 'js', 'app-mcp-market.js');
    const ctx = loadMarketModuleEmpty(file, {
      code: 200,
      data: { total_count: 0, mcp_server_list: [] },
    });
    await ctx.market.refresh();
    const html = ctx.grid.innerHTML;
    assert.ok(!html.includes('retry-catalog'),
      v.tag + ': registry_error 软失败空态已随官方源下线，不得复活: ' + html);
    assert.ok(!/mcp-market-empty-err/.test(html),
      v.tag + ': 软失败专用空态 class 不得复活: ' + html);
    assert.ok(/未找到 MCP/.test(html), v.tag + ': 空目录应显示「未找到 MCP 服务」: ' + html);
  }
});

test('㉗ 授权徽标别名归一 + 详情扁平 authType（静态接线护栏）', () => {
  VARIANTS.forEach(v => {
    const js = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    /* 后端 AuthKind::parse（auth.rs）仍接受 token/oauth 两族的别名拼写
     * （static/apikey/api_key、oauth2/browser/login），卡片与详情徽标必须同口径
     * 归一，否则「后端要授权、卡片无徽标」。 */
    assert.match(js, /function canonicalAuthKind\(/, v.tag + ': 缺授权形态别名归一');
    assert.match(js, /canonicalAuthKind\(it\.auth_kind\)/, v.tag + ': 卡片徽标未走归一');
    assert.match(js, /canonicalAuthKind\(detailAuthKind\(d\)\)/, v.tag + ': 详情徽标未走归一');
    /* 反向断言：qrcode/scan 一族后端已归入 AuthKind::None（不再授权），前端
     * 若仍把它归一成 'qrcode_poll' 并画「扫码授权」徽标，就是空头承诺——
     * 用户点连接后 needsAuth:false、一个弹窗都不弹，连接器 401 且无从下手。
     * 这是 2026-11 官方源下线轮的收尾项，护栏防复活。 */
    assert.ok(!/return 'qrcode_poll'/.test(js),
      v.tag + ': canonicalAuthKind 不得再归一出 qrcode_poll（后端已归 None，徽标是空头承诺）');
    assert.ok(!/scan_badge/.test(js),
      v.tag + ': scan_badge 键已随扫码徽标删除，不得复活');
    assert.ok(!/mcp-market-(?:badge-)?scan/.test(js),
      v.tag + ': 扫码徽标 class 已删，不得复活');
    /* 后端 normalize 兼容扁平 authType，详情只读嵌套会「卡片有徽标、详情无」。 */
    assert.match(js, /cfg\.authType/, v.tag + ': detailAuthKind 未兼容扁平 authType');
    /* 分类请求必须带 source（三个源的分类表完全不同：魔搭 kebab key /
     * 腾讯数字 id / Smithery 无分类）。SolonCode 集成轮由「不得带」反转为「必须带」。 */
    assert.match(js, /API\.categories[^\n]*source=/,
      v.tag + ': 分类请求必须携带 source 参数（三源分类表分流）');
  });
});

/* ===== ㉚ 2026-11 安装链路修复轮回归护栏（行为级，vm 跑真实源码） =====
 *
 * 修1：install 假成功 —— mcp_server_add 返回 code 200 但 connected:false +
 *      connectError 时，旧前端只判 code、照样弹绿色「已安装」。后端现透传
 *      connectErrors，前端必须弹 warning、绝不弹 success。
 * 修4：广场卡片「已安装」态 —— 匹配口径 = 后端落盘的 marketId（不是名字，
 *      落盘名多为 fetch/time 等通用名且重名会加 -2 后缀）。已安装卡的 + 号
 *      按钮必须换成对勾 disabled 态；名单拉取失败必须静默降级（全部按未安装
 *      渲染），不得让广场加载失败。
 */

/** 可控 fetch 的沙箱：installedList 为 null 时 /mcp/servers 返回 500（降级路径）。 */
function mkInstallSandbox(base, opts) {
  const els = {};
  function mkEl(id) {
    return {
      id, _ls: {}, _html: '', value: '', style: {}, attrs: {}, textContent: '',
      addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      classList: { toggle() {} },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      closest() { return null; },
      set innerHTML(v) { this._html = v; },
      get innerHTML() { return this._html; },
    };
  }
  const root = mkEl('mcpMarketRoot');
  els['mcpMarketRoot'] = root;
  els['mcpMarketDetail'] = mkEl('mcpMarketDetail');
  const grid = mkEl('mcpMarketGrid');
  els['mcpMarketGrid'] = grid;
  const toasts = [];
  const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams,
    document: {
      getElementById: id => els[id] || null,
      querySelector: sel => (sel === '#mcpMarketRoot' ? root : null),
      addEventListener() {},
    },
    window: { addEventListener() {}, showToast: (m, t) => toasts.push({ m, t }), GourdI18n: null },
    fetch: async (url, init) => {
      url = String(url);
      if (/market\/install/.test(url)) return ok(opts.installData);
      if (/market\/detail/.test(url)) return ok({
        name: 'Fetch', description: 'd', readme: '',
        env_schema: { properties: {}, required: [] },
        server_config: [{ mcpServers: { fetch: { command: 'uvx' } } }],
      });
      if (/market\/categories/.test(url)) return ok([{ key: '', nameZh: '全部', name: 'All' }]);
      if (/market\/servers/.test(url)) return ok({ total_count: 1, mcp_server_list: [{ id: '@a/b', name: 'B' }] });
      /* 已落盘名单端点 /web/settings/mcp/servers（注意不带 market 段）。 */
      if (/\/mcp\/servers/.test(url)) {
        if (opts.installedList === null) return { ok: false, status: 500, json: async () => ({ code: 500, description: 'boom' }) };
        return ok(opts.installedList || []);
      }
      return ok({});
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(path.join(base, 'js', 'app-mcp-market.js')), sandbox, { filename: 'app-mcp-market.js' });
  const market = sandbox.window._mcpMarket;
  market.setHost('#mcpMarketRoot');
  return { market, root, grid, modal: els['mcpMarketDetail'], toasts };
}

test('㉚ 修1：connectErrors 非空时必须弹 warning「已保存但连接失败」，绝不弹绿色成功', async () => {
  for (const v of VARIANTS) {
    // (a) 半成功：installed 已落盘 + connectErrors 非空 → 只有 warning，无 success。
    const h = mkInstallSandbox(v.base, {
      installData: {
        installed: ['fetch'],
        connectErrors: [{ name: 'fetch', error: 'spawn uvx ENOENT' }],
      },
      installedList: [{ name: 'fetch', marketId: '@a/b' }],
    });
    await h.market.install('@a/b', {});
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.toasts.length, 1, v.tag + ': 应恰好一条 toast，实际 ' + JSON.stringify(h.toasts));
    assert.equal(h.toasts[0].t, 'warning',
      v.tag + ': connectErrors 非空仍弹 ' + h.toasts[0].t + '（假成功回归：连不上的服务弹绿色已安装）');
    assert.ok(h.toasts[0].m.includes('spawn uvx ENOENT'),
      v.tag + ': warning 文案丢失真实连接失败原因: ' + h.toasts[0].m);
    assert.ok(h.toasts[0].m.includes('fetch'),
      v.tag + ': warning 文案要指名失败的连接器: ' + h.toasts[0].m);
    assert.ok(!h.toasts.some(t => t.t === 'success'), v.tag + ': 半成功态不得出现 success toast');

    // (b) 全连接成功（connectErrors 空数组）→ 保持原有绿色 installed_names。
    const h2 = mkInstallSandbox(v.base, {
      installData: { installed: ['fetch'], connectErrors: [] },
      installedList: [],
    });
    await h2.market.install('@a/b', {});
    await new Promise(r => setTimeout(r, 30));
    assert.ok(h2.toasts.some(t => t.t === 'success' && t.m.includes('fetch')),
      v.tag + ': 全部连接成功必须仍弹绿色已安装: ' + JSON.stringify(h2.toasts));
    assert.ok(!h2.toasts.some(t => t.t === 'warning'), v.tag + ': 全成功不得误报 warning');

    // (c) 旧内核（无 connectErrors 字段）→ 行为与改造前一致（success）。
    const h3 = mkInstallSandbox(v.base, { installData: { installed: ['fetch'] }, installedList: [] });
    await h3.market.install('@a/b', {});
    await new Promise(r => setTimeout(r, 30));
    assert.ok(h3.toasts.some(t => t.t === 'success'), v.tag + ': 缺 connectErrors 字段的老响应必须兼容');
  }
});

test('㉛ 修4：已安装卡片（marketId 命中）+ 按钮为对勾 disabled 态；名单失败静默降级', async () => {
  for (const v of VARIANTS) {
    // (a) marketId 命中：卡片带 installed 类 + 徽标，+ 按钮 disabled 且不再是 install 入口。
    const h = mkInstallSandbox(v.base, {
      installData: { installed: [] },
      installedList: [{ name: 'fetch-2', marketId: '@a/b' }],  // 落盘名带后缀也必须命中
    });
    await h.market.refresh();
    await new Promise(r => setTimeout(r, 30));
    const html = h.grid.innerHTML;
    assert.ok(/mcp-market-card-installed/.test(html),
      v.tag + ': marketId 命中的卡片缺 .mcp-market-card-installed 类（按名字匹配会在加后缀后失效）');
    assert.ok(/mcp-market-installed-badge/.test(html), v.tag + ': 已安装卡片缺徽标');
    const btnM = /<button[^>]*mcp-market-card-add[^>]*>/.exec(html);
    assert.ok(btnM, v.tag + ': 卡片右上角按钮缺失');
    assert.ok(/\bdisabled\b/.test(btnM[0]),
      v.tag + ': 已安装卡片的 + 按钮必须是 disabled 对勾态: ' + btnM[0]);
    assert.ok(!/data-act="install"/.test(btnM[0]),
      v.tag + ': 已安装按钮不得再挂 install 动作');
    assert.ok(/polyline/.test(html), v.tag + ': 已安装按钮应画对勾而不是 + 号');

    // (b) 未命中（marketId 不同 / 无 marketId 的手动条目）：保持可安装的 + 号。
    const h2 = mkInstallSandbox(v.base, {
      installData: { installed: [] },
      installedList: [{ name: 'fetch', marketId: '@other/x' }, { name: 'time' }],
    });
    await h2.market.refresh();
    await new Promise(r => setTimeout(r, 30));
    const html2 = h2.grid.innerHTML;
    assert.ok(!/mcp-market-card-installed/.test(html2),
      v.tag + ': 按名字/无 marketId 匹配出现误判（唯一口径是 marketId === 市场 id）');
    assert.ok(/data-act="install"/.test(html2), v.tag + ': 未安装卡片必须保留 + 号安装入口');

    // (c) 名单端点失败：静默降级，广场照常渲染、全部按未安装、无错误 toast。
    const h3 = mkInstallSandbox(v.base, { installData: { installed: [] }, installedList: null });
    await h3.market.refresh();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(/data-act="install"/.test(h3.grid.innerHTML),
      v.tag + ': 名单拉取失败必须降级为未安装渲染，不得让广场加载失败');
    assert.ok(!/mcp-market-card-installed/.test(h3.grid.innerHTML), v.tag + ': 降级态不得画已安装');
    assert.equal(h3.toasts.length, 0, v.tag + ': 名单失败必须静默，不得弹错误 toast');

    // (d) 详情弹窗：已安装条目顶部画徽标，主按钮「连接」仍可点（重复安装装成 name-2 可接受）。
    const h4 = mkInstallSandbox(v.base, {
      installData: { installed: [] },
      installedList: [{ name: 'fetch', marketId: '@a/b' }],
    });
    await h4.market.refresh();
    await new Promise(r => setTimeout(r, 30));
    await h4.market.showDetail('@a/b');
    const modalHtml = h4.modal.innerHTML;
    assert.ok(/mcp-market-installed-badge/.test(modalHtml), v.tag + ': 已安装条目的详情弹窗缺徽标');
    assert.ok(/data-confirm/.test(modalHtml), v.tag + ': 已安装条目的「连接」主按钮不得被禁用');
  }
});

test('㉜ 修1/2/3/4 Rust 接线护栏：预检/后缀/connectErrors/marketId 必须在 install 必经之路上', () => {
  const rs = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'mcp_market_api.rs'));
  const st = read(path.join(REPO, 'gourd-work', 'core', 'src', 'server', 'settings_api.rs'));
  // 修1：循环里必须收集 connect_error 并随成功响应透传 connectErrors。
  assert.match(rs, /collect_connect_error\(&name, &resp\)/, '修1: install 循环未收集连接失败');
  assert.match(rs, /"connectErrors": connect_errors/, '修1: 成功响应未透传 connectErrors');
  // 修2：落盘前读已存名单并分配唯一名。
  assert.match(rs, /read_settings_key\("mcpServers"\)/, '修2: 未读已存 mcpServers 名单');
  assert.match(rs, /assign_unique_names\(&mut entries, &mut taken\)/, '修2: 未做重名后缀分配');
  // 修3：预检必须先于后缀分配与落盘循环（顺序锁：preflight 的调用位置在 assign 之前）。
  const preIdx = rs.indexOf('preflight_entries(&entries)');
  const assignIdx = rs.indexOf('assign_unique_names(&mut entries');
  const addIdx = rs.indexOf('mcp_server_add(State(state.clone())');
  assert.ok(preIdx > 0 && assignIdx > preIdx && addIdx > assignIdx,
    '修3: 必须 预检 → 后缀分配 → 落盘 的顺序（预检名单与落盘名单一致，任一失败零落盘）');
  // 预检判据与落盘同源：preflight 内部必须调 settings_api 的 build_entry。
  assert.match(rs, /pub fn preflight_entries[\s\S]{0,400}build_entry\(body, None\)/,
    '修3: 预检必须复用 build_entry（另抄校验必然分叉）');
  // 修4：marketId 全链路（McpBody 字段 → build_entry 落盘 → mcp_servers 透传）。
  assert.match(st, /rename = "marketId"/, '修4: McpBody 缺 marketId 字段');
  assert.match(st, /prev_meta\("marketId", &body\.market_id\)/, '修4: build_entry 未落盘/保留 marketId');
  assert.match(st, /\["displayName", "iconUrl", "description", "marketId"\]/,
    '修4: mcp_servers 未透传 marketId（前端已安装索引拿不到匹配口径）');
  assert.match(rs, /attach_catalog_meta\(&data, &body\.id, &mut entries\)/,
    '修4: install 未把目录 id 作为 marketId 附着到条目');
  // 手动添加的重名 400 必须保持不变（仅市场路径加后缀）。
  assert.match(st, /Server name already exists/, '手动添加 mcp_server_add 的重名 400 不得被移除');
});
