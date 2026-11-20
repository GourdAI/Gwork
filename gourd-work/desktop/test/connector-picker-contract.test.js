/**
 * 对话内连接器选择器（WorkBuddy 式）契约回归。
 *
 * ── 用户需求 ──────────────────────────────────────────────────────────────
 * 「参考 workbuddy，在对话时可选择连接器」；默认语义用户拍板【默认不启用】：
 * 不勾选 = 本会话没有任何连接器工具（不是"全部启用"）。
 *
 * ── 钉死的契约 ────────────────────────────────────────────────────────────
 * 前端：双宿主 DOM（欢迎页/对话页）、脚本装载顺序、会话继承与回显接线、
 *       图标降级（名字字母底 + 代理 img）、i18n 键集（12 语言 × 双壳）。
 * 后端（源码接线断言，行为级由 Rust 单测承担）：
 *       SessionContext.mcpServers、/web/chat/mcp/select 路由、
 *       chat_models 回显、run 路径 gate 注入（Some(空)=无连接器）、
 *       ToolGate 双端（visible_mcp_tools + execute）与子代理继承。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(ROOT, 'gourd-work', 'desktop', 'ui');
const UI2 = path.join(ROOT, 'gourd-ai-tauri', 'ui');
const CORE = path.join(ROOT, 'gourd-work', 'core', 'src');
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

const pickerJs = read(path.join(UI, 'js', 'app-connector-picker.js'));
const chatHtml = read(path.join(UI, 'chat.html'));
const bootstrap = read(path.join(UI, 'js', 'app-bootstrap.js'));
const historyJs = read(path.join(UI, 'js', 'app-history.js'));
const appCss = read(path.join(UI, 'css', 'app.css'));
const serverMod = read(path.join(CORE, 'server', 'mod.rs'));
const sessionMod = read(path.join(CORE, 'session', 'mod.rs'));
const registryRs = read(path.join(CORE, 'tools', 'registry.rs'));
const teamRs = read(path.join(CORE, 'team', 'mod.rs'));

test('① 双宿主 DOM：欢迎页托盘 + 对话页工具栏各有连接器选择器，id 不重复', () => {
    for (const id of ['welcomeConnSelector', 'welcomeConnDropdown', 'chatConnSelector', 'chatConnDropdown']) {
        const n = chatHtml.split('id="' + id + '"').length - 1;
        assert.equal(n, 1, id + ' 必须恰好出现一次');
    }
    assert.match(chatHtml, /class="conn-selector composer-tray-item" id="welcomeConnSelector"/,
        '欢迎页宿主在 composer-tray 内（与项目/权限选择器并排）');
    assert.match(chatHtml, /class="conn-selector" id="chatConnSelector"/, '对话页宿主在 input-toolbar 左区');
    // 静态 label 带 data-i18n（首帧翻译），选中数由 JS 动态改写
    assert.match(chatHtml, /class="conn-label" data-i18n="app\.conn_pick_label"/);
});

test('② 脚本装载：picker 在 app-history 之后（setActiveSession 钩子链）、随 access-mode 相邻', () => {
    const at = bootstrap.indexOf("'/js/app-connector-picker.js'");
    assert.ok(at > 0, 'APP_SCRIPTS 必须装载 picker');
    assert.ok(at > bootstrap.indexOf("'/js/app-history.js'"), '必须在 app-history 之后（钩子链依赖）');
    assert.ok(at > bootstrap.indexOf("'/js/app-access-mode.js'"), '与档位选择器同族相邻');
});

test('③ 默认不启用：空选择不得回退成"全部"，勾选走 toggle+persist', () => {
    // 内存真源初始为空数组；无缓存会话切换回空
    assert.match(pickerJs, /var currentPicked = \[\];/);
    assert.match(pickerJs, /currentPicked = \(sessionId && sessionPickMap\[sessionId\]\) \? sessionPickMap\[sessionId\]\.slice\(\) : \[\];/);
    // 持久化显式携带 JSON 数组（空数组也发——内核 Some([]) 语义）
    assert.match(pickerJs, /servers: JSON\.stringify\(picked\)/);
    assert.match(pickerJs, /SELECT_URL = '\/web\/chat\/mcp\/select'/);
    // 归属头与档位选择器同口径（缺头会写出第二份 context.json）
    assert.match(pickerJs, /window\.sessionCwdHeaders\(session\)/);
});

test('④ 会话继承与回显接线：inheritSelectionToSession + refreshSessionModel 双路径', () => {
    assert.match(historyJs, /GourdConnPicker\.inheritToSession\(newSessionId\)/,
        '新建会话必须继承选择（含空选择），否则欢迎页勾选带不过去');
    assert.match(historyJs, /GourdConnPicker\.applyServerSelection\(sessionId, data\.mcpServers\)/,
        '刷新后回显走 /web/chat/models 同一响应，不另发请求');
    // 本端缓存优先：后端回填不得覆盖刚做的本地选择
    assert.match(pickerJs, /if \(sessionPickMap\[sessionId\]\) return;/);
});

test('⑤ 图标降级与技能/连接器卡同款：字母底 + 内核代理 img + onerror 自毁', () => {
    assert.match(pickerJs, /displayName\.substring\(0, 2\)\.toUpperCase\(\)/);
    assert.match(pickerJs, /\/web\/settings\/skills\/icon\?url=/);
    assert.match(pickerJs, /onerror="this\.remove\(\)"/);
    assert.match(pickerJs, /window\.__gworkApiUrl === 'function'/, '桌面壳必须取内核绝对地址');
    // CSS：图标容器化（img 叠上层），不得写死白底
    assert.match(appCss, /\.conn-pick-icon \{ position: relative;/);
    assert.doesNotMatch(/\.conn-pick-icon[^}]*\}/.exec(appCss)[0], /#fff/, '图标底禁写死白色');
});

test('⑥ 列表只列已启用连接器；管理入口直达技能页·连接器（挂起导航防异步覆盖）', () => {
    assert.match(pickerJs, /it\.enabled !== false/);
    assert.match(pickerJs, /window\.switchSkillsView\('connectors'\)/);
    const skillsJs = read(path.join(UI, 'js', 'app-skills.js'));
    assert.match(skillsJs, /window\.switchSkillsView = function/, '导航入口必须存在');
    assert.match(skillsJs, /_pendingNavView/, 'resetAndLoad 异步回调会覆盖同步 switchView，必须走挂起目标');
});

test('⑦ i18n：conn_pick 键集 5 键 × 12 语言 × 双壳逐字节一致', () => {
    const KEYS = ['conn_pick_label', 'conn_pick_title', 'conn_pick_empty', 'conn_pick_manage', 'conn_pick_failed'];
    const langs = fs.readdirSync(path.join(UI, 'locales')).filter(f => f.endsWith('.json'));
    assert.equal(langs.length, 12);
    for (const f of langs) {
        const a = read(path.join(UI, 'locales', f));
        const b = read(path.join(UI2, 'locales', f));
        assert.equal(a, b, f + ' 双壳必须逐字节一致');
        const json = JSON.parse(a);
        for (const k of KEYS) {
            assert.ok(json.app && typeof json.app[k] === 'string' && json.app[k].length > 0,
                f + ' 缺 app.' + k);
        }
    }
});

test('⑧ 双壳同步：涉改前端文件逐字节一致', () => {
    for (const f of ['chat.html', 'js/app-bootstrap.js', 'js/app-history.js', 'js/app-skills.js', 'js/app-connector-picker.js', 'css/app.css']) {
        assert.equal(read(path.join(UI, f)), read(path.join(UI2, f)), f + ' 双壳漂移');
    }
});

test('⑨ 内核接线：context 字段 + select 路由 + models 回显 + run gate 注入', () => {
    assert.match(sessionMod, /pub mcp_servers: Option<Vec<String>>/, 'SessionContext 持久化字段');
    assert.match(sessionMod, /rename = "mcpServers"/, '落盘键名与前端回显口径一致');
    assert.match(serverMod, /"\/web\/chat\/mcp\/select", post\(chat_mcp_select\)/, '路由注册');
    assert.match(serverMod, /"mcpServers": mcp_servers/, 'chat_models 回显');
    // run 路径：交互聊天恒建 gate，Some(空)=无连接器（默认不启用的内核落点）
    assert.match(serverMod, /with_mcp_servers\(Some\(\s*session_ctx\.mcp_servers\.clone\(\)\.unwrap_or_default\(\)/,
        '交互 run 必须把会话选择注入 gate；unwrap_or_default 保证 None→空集→无连接器');
    // 非交互路径保持全量（CLI/ACP/loop 不受选择器影响）
    const loopRunner = read(path.join(CORE, 'server', 'loop_runner.rs'));
    assert.match(loopRunner, /gate: None/, '循环任务不经会话选择器');
});

test('⑩ 门控双端 + 子代理继承：可见与执行同源，定义不得放大选择', () => {
    assert.match(registryRs, /pub mcp_servers: Option<std::collections::HashSet<String>>/, 'ToolGate 选择轴');
    assert.match(registryRs, /g\.allows_server\(&t\.server_name\)/, '可见端过滤');
    assert.match(registryRs, /!gate\.allows\(&t\.name, true\) \|\| !gate\.allows_server\(&t\.server_name\)/, '执行端过滤');
    assert.match(teamRs, /with_mcp_servers\(parent\.mcp_servers\.clone\(\)\)/, '子代理继承会话选择');
    const agentRs = read(path.join(CORE, 'tools', 'agent.rs'));
    assert.match(agentRs, /mcp_servers: ctx\.gate\.as_ref\(\)\.and_then\(\|g\| g\.mcp_servers\.clone\(\)\)/, '委托链透传');
});