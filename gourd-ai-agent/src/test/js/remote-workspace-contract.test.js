'use strict';
/* 契约：远程工作区 P1（SSH 骨架）+ P2（WSL）+ P3（CLI 预装）前端链路。
 *
 * 锁定的关键行为（对应 远程工作区方案.md 方案 A，P0 修复后架构：
 * 数据面由本地 UI 服务器反代切换承载，前端不改写任何请求地址）：
 * 1. app-remote.js 必须存在且注册进 app-bootstrap.js 的加载序列（在 app-workspace 之后）
 * 2. 反代架构：前端不得改写请求地址/注入 Authorization（跨源+预检必死，浏览器 WS
 *    无法带自定义头）；Rust 侧 server.rs 按工作区分流（REMOTE_ROUTE + upstream_for）
 *    前端无 fetch/ajax 拦截残留、无 __remoteHttpBase/__remoteWsBase 暴露面。
 * 3. 连接/断开时重建长连接（connectWebGate + onRemoteChannelChanged）
 * 4. 连接凭据（密码/口令）绝不进 localStorage——只存非敏感字段（channel/host/port/user/authType/keyPath）
 * 5. workspace-remote-btn 不再 disabled（P1 激活）
 * 6. index.html 挂载 #remoteWizard 容器
 * 7. i18n 12 语言包 remote.* 31 键齐全（P1 21 + P2/P3 10）
 * 8. P2/P3：向导三通道 tab；WSL 仅 win32 宿主（桌面壳经 electronAPI.platform，
 *    浏览器直开经 UA 兜底——Windows 浏览器也须能看到 WSL 入口，非 Windows
 *    宿主不出现该通道；无桌面壳时向导显示「需要桌面端」说明而非静默缺项）；
 *    只放 WSL2；预装模式提示 + 回退语义；remoteWslList 桥接静默降级空数组
 * 9. 启动恢复：LS_ACTIVE 写后必读（remoteState 查询后恢复徽标或清残留）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const STATIC = path.join(__dirname, '..', '..', 'main', 'resources', 'static');
const remote = fs.readFileSync(path.join(STATIC, 'js', 'app-remote.js'), 'utf8');
const workspace = fs.readFileSync(path.join(STATIC, 'js', 'app-workspace.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(STATIC, 'js', 'app-bootstrap.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');

/** 行尾归一：工作树是 CRLF（git `i/lf w/crlf` + core.autocrlf），而源码里写死的
 *  切片标记常含裸 `\n`（如 `'PREINSTALLED_CHANNEL_ENABLED\n'`、`'}\n    }'`）。
 *  CRLF 文本里不存在 `"}\n"`，这类标记会恒失配并报「标记必须存在」——看起来
 *  像实现缺失/回归，实际只是行尾风格差异造成的假红（2026-10-13 实测 2 例）。
 *  统一在切片前归一到 LF：标记与源码同口径，行尾风格不再影响契约判定。 */
function lf(s) {
  return String(s).replace(/\r\n/g, '\n');
}

function sliceBetween(src, startMark, endMark) {
  const s0 = lf(src);
  const start = lf(startMark);
  const end = lf(endMark);
  const s = s0.indexOf(start);
  assert.ok(s >= 0, '起始标记必须存在: ' + startMark);
  const e = s0.indexOf(end, s + start.length);
  assert.ok(e > s, '结束标记必须存在: ' + endMark);
  return s0.slice(s, e);
}

test('app-remote.js 注册进加载序列，且在 app-workspace 之后', () => {
  const wsIdx = bootstrap.indexOf("'/js/app-workspace.js'");
  const remoteIdx = bootstrap.indexOf("'/js/app-remote.js'");
  assert.ok(remoteIdx > 0, 'app-bootstrap.js 必须加载 app-remote.js');
  assert.ok(wsIdx > 0 && remoteIdx > wsIdx, '必须在 app-workspace 之后（共享下拉挂载点事件）');
});

test('反代架构：前端不得改写请求地址或注入 Authorization（P0 修复后契约）', () => {
  // 头注释锁定架构：数据面由本地 UI 服务器按工作区分流切换上游承载
  //（旧断言锁的是整机切换时代的入口名，该入口已删——旁路置活入口正是
  //  「一连远端就整机切走」的复发温床，因此注释改说分流表与 bind_scope）
  assert.match(remote, /REMOTE_ROUTE/, '头部注释必须指向按工作区分流的反代架构');
  assert.match(remote, /remote_bind_scope/, '头注释必须说明归属由 bind_scope 声明');
  assert.doesNotMatch(remote, /set_remote_override/, '不得再提整机切换入口（已删除的旁路激活）');
  // 旧方案的跨源改写面必须全部清除：
  // fetch 拦截残留（改写 URL + 注入头）
  assert.doesNotMatch(remote, /window\.fetch\s*=\s*function/, '不得再拦截 window.fetch（同源请求直走本地 UI 服务器）');
  assert.doesNotMatch(remote, /\$\.ajaxPrefilter/, '不得再拦截 $.ajax');
  // 拦截用的路径正则与隧道地址改写必须不存在
  assert.doesNotMatch(remote, /BACKEND_PATH_RE/, '不得有后端路径拦截正则');
  // 暴露给拦截层的基础地址函数必须不存在（不再有消费方）
  assert.doesNotMatch(remote, /__remoteHttpBase/, '不得暴露 __remoteHttpBase（无改写则无需要）');
  assert.doesNotMatch(remote, /__remoteWsBase/, '不得暴露 __remoteWsBase（WS 走同源代理）');
  assert.doesNotMatch(remote, /__remoteAuthHeader/, '不得暴露 __remoteAuthHeader（凭据由代理注入）');
});

test('并存语义：连接不清选择不重建长连接；断开/探活失败仅当选着远端时回位', () => {
  // 【连接 ≠ 切换环境】applyConnection 必须保留当前选择、不得强制重建长连接
  //（WebGate 带 ?cwd= 按选择分流，选择未变则旧连接上游本就正确）。
  const applySeg = sliceBetween(remote, 'function applyConnection', 'function doConnect');
  assert.doesNotMatch(applySeg, /window\.connectWebGate/, '连接建立不得强制重建 WebGate（选择未变时上游未变）');
  assert.doesNotMatch(applySeg, /refreshContextForChannel\(''\)/, '连接建立不得清空当前选择（并存语义）');
  assert.match(applySeg, /refreshContextForChannel\(\)/, '连接建立后重拉合并列表（本地+远端两份）');
  // 断开：仅当选着远端工作区（__lastRemoteWorkspace）时才清选择+重建长连接
  const discSeg = sliceBetween(remote, 'function doDisconnect', '/* ================= WSL');
  assert.match(discSeg, /__lastRemoteWorkspace/, '断开必须按「是否选着远端」分流回位');
  assert.match(discSeg, /window\.connectWebGate/, '选着远端时断开必须重建 WebGate（旧连接指已死隧道）');
  // 探活失败路径（onRemoteState）同样回位
  const stateSeg = sliceBetween(remote, 'onRemoteState(function', '/* 模型镜像结果提示');
  assert.match(stateSeg, /__lastRemoteWorkspace/, '探活失败也必须回位（远端目录已不可达）');
  assert.match(stateSeg, /window\.connectWebGate/, '探活失败回位后重建长连接');
});

test('启动恢复：LS_ACTIVE 写后必读（方案B：remoteList 交叉恢复全部在线连接）', () => {
  /* 【codereview 2026-10-10】旧壳回退链已抽为具名函数 tryRestoreViaStateChain（remoteList
     空列表时也复用它核实，见 multi-remote-concurrency 测试）：切片起点必须覆盖函数体，
     否则「清残留/remoteState 查询」都在函数体内，旧起点（restoreOnBoot 直切）会误报缺失。 */
  const seg = sliceBetween(remote, 'function tryRestoreViaStateChain', '})();');
  assert.match(seg, /readActiveIds\(\)/, '启动时必须读回上次在线连接 id 数组（readActiveIds 内含 LS_ACTIVE 读取与旧单值迁移）');
  assert.match(remote, /function readActiveIds\(\)[\s\S]{0,200}localStorage\.getItem\(LS_ACTIVE\)/,
    'readActiveIds 必须真读 LS_ACTIVE（不得只读内存）');
  assert.match(seg, /remoteList/, '多连接恢复主路径：Rust remote_list 是在线真相源');
  assert.match(seg, /remoteState/, '旧壳回退路径仍须经 remoteState 查询连接存活');
  assert.match(seg, /persistActiveIds\(\[\]\)/, '连接已死必须清残留标记');
});

test('app-streaming/app-terminal 暴露重建入口', () => {
  const streaming = fs.readFileSync(path.join(STATIC, 'js', 'app-streaming.js'), 'utf8');
  const terminal = fs.readFileSync(path.join(STATIC, 'js', 'app-terminal.js'), 'utf8');
  assert.match(streaming, /window\.connectWebGate = connectWebGate/, 'app-streaming 必须暴露 connectWebGate');
  assert.match(terminal, /window\.onRemoteChannelChanged/, 'app-terminal 必须暴露 onRemoteChannelChanged');
});

test('敏感凭据不落 localStorage', () => {
  const persist = sliceBetween(remote, 'function persistActive', '/* ================= 连接状态');
  // saveHosts 只存 host/port/user/authType/keyPath；password/passphrase 不得出现
  const saveHosts = sliceBetween(remote, 'function saveHosts', 'function persistActive');
  assert.ok(!/password|passphrase/i.test(saveHosts.replace(/localStorage/g, '')),
    'saveHosts 存储列表不得含 password/passphrase 字段');
  assert.doesNotMatch(persist, /password/i, 'persistActive 不得触碰密码');
});

test('doConnect 保存主机时只落非敏感字段', () => {
  const save = sliceBetween(remote, 'var hosts = savedHosts().filter', 'saveHosts(hosts.slice');
  assert.match(save, /host: cfg\.host/);
  assert.match(save, /user: cfg\.user/);
  assert.match(save, /authType: cfg\.authType/);
  assert.match(save, /keyPath: cfg\.keyPath/, 'keyPath 属非敏感字段（路径不是秘密，口令才是）');
  // 敏感字段检查：保存块内不得出现 password/passphrase 的键赋值
  assert.doesNotMatch(save, /password\s*[:=]|passphrase\s*[:=]/, '保存条目不得含敏感字段');
});

test('workspace-remote-btn 已激活（P1 交付面）', () => {
  assert.doesNotMatch(workspace, /workspace-remote-btn" disabled/,
    '远程连接按钮不得再 disabled');
  assert.match(workspace, /workspace-remote-btn/, '按钮仍存在');
});

test('index.html 挂载 #remoteWizard 容器', () => {
  assert.match(indexHtml, /id="remoteWizard"/, '必须有向导容器');
  assert.match(indexHtml, /remote-wizard-backdrop/, '必须是 backdrop 形态（body 级浮层）');
});

/* ===== 桌面壳接线（ACL 链，与 sidebar-update-badge.test.js 同范式） ===== */
const REPO = path.join(__dirname, '..', '..', '..', '..');
function readRepo(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

test('Tauri 壳：remote 命令四层接线齐备（command/manifest/capability/bridge）', () => {
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /pub async fn remote_connect/, 'remote_connect 命令');
  assert.match(modRs, /pub async fn remote_disconnect/, 'remote_disconnect 命令');
  assert.match(modRs, /pub async fn remote_state/, 'remote_state 命令');
  assert.match(modRs, /pub async fn remote_wsl_list/, 'remote_wsl_list 命令（P2）');

  const mainRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'main.rs'));
  for (const cmd of ['remote_connect', 'remote_disconnect', 'remote_state', 'remote_wsl_list']) {
    assert.ok(mainRs.includes(`remote::${cmd}`), `main.rs 必须注册 ${cmd}`);
  }

  const buildRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'build.rs'));
  for (const cmd of ['remote_connect', 'remote_disconnect', 'remote_state', 'remote_wsl_list']) {
    assert.ok(buildRs.includes(`"${cmd}"`), `build.rs COMMANDS 必须登记 ${cmd}（否则远程源 ACL 静默拒绝）`);
  }

  const caps = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'capabilities', 'default.json'));
  for (const perm of ['allow-remote-connect', 'allow-remote-disconnect', 'allow-remote-state', 'allow-remote-wsl-list']) {
    assert.ok(caps.includes(`"${perm}"`), `capabilities 必须授权 ${perm}`);
  }

  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /remoteConnect:\s*function/, '桥接层暴露 remoteConnect');
  assert.match(bridge, /onRemoteProgress:\s*function/, '桥接层暴露进度事件订阅');
  // P2/P3：channel 参数透传 + remoteWslList
  assert.match(bridge, /invoke\('remote_connect', \{[\s\S]*?channel:/, 'remoteConnect 必须透传 channel 参数');
  assert.match(bridge, /remoteWslList:\s*function/, '桥接层暴露 remoteWslList');
});

test('Java 侧：远端模式凭据注入与 meta 标记（跨端契约）', () => {
  const flags = readRepo(path.join('gourd-ai-agent', 'src', 'main', 'java', 'com', 'gourdai', 'core', 'config', 'AgentFlags.java'));
  assert.match(flags, /PROP_REMOTE_WEB_AUTH\s*=\s*"gwork\.web\.auth"/, '凭据注入属性名');
  assert.match(flags, /PROP_REMOTE\s*=\s*"gwork\.remote"/, '远端模式属性名');

  const ctrl = readRepo(path.join('gourd-ai-agent', 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebController.java'));
  assert.match(ctrl, /data\.put\("remote", AgentFlags\.isRemoteDeployed\(\)\)/, 'meta 必须回告 remote 标记');

  const filter = readRepo(path.join('gourd-ai-agent', 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebAuthFilter.java'));
  assert.match(filter, /getRemoteWebAuth\(\)/, 'Filter 必须优先消费注入凭据');
});

/* ===== i18n remote.* 完整性 =====
   两层断言：
   1) 硬锁关键键清单（防误删）；
   2) **从 app-remote.js / app-workspace.js 源码派生**「前端实际引用的 remote.* 键」
      必须 12 语言包全齐（新增键自动纳入，不靠人记得扩清单）。
      上一轮只写死清单，结果 P4 那批键（jump_、reconnect_、mirror_ 开头的十个）完全没人守，
      本轮新加的 scope_bind_failed 也会重跟——所以改为派生。 */
const LOCALES = path.join(STATIC, 'locales');
const REMOTE_KEYS = ['title', 'unsupported', 'saved_hosts', 'no_saved_hosts', 'new_connection',
  'host_placeholder', 'user_placeholder', 'auth_password', 'auth_key', 'password_placeholder',
  'keypath_placeholder', 'passphrase_placeholder', 'browse', 'connect_btn', 'connecting_to',
  /* badge_title/badge_count 2026-10-16 随徽标整体下线删除（零消费死键，
     硬锁清单只锁活键；'badge' 仍是分组标签回落文案，保留） */
  'connected_ok', 'connect_failed', 'host_user_required', 'remove_host', 'badge',
  /* P2/P3 新增 */
  'channel_ssh', 'channel_wsl', 'channel_preinstalled', 'connecting_wsl',
  'wsl_user_placeholder', 'wsl_hint', 'wsl_loading', 'wsl_none', 'wsl_none_v2', 'preinstalled_hint',
  /* 静态验证轮新增：模型镜像自动推送失败的打扰提示（P1-B 闭环） */
  'mirror_auto_failed',
  /* 分流轮新增：工作区归属登记失败提示 */
  'scope_bind_failed',
  /* 离线/内网改造一期：离线运行时包选择行 */
  'runtime_pkg_label', 'runtime_pkg_hint'];

/** 从 JS 源码提取被引用的 remote.* 键名（只看真实调用，不包注释里的字面量）。 */
function referencedRemoteKeys() {
  const keys = new Set();
  for (const name of ['app-remote.js', 'app-workspace.js']) {
    const src = fs.readFileSync(path.join(STATIC, 'js', name), 'utf8');
    // 先剔块注释与行注释：设计文档里常引用键名作说明，不算引用
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const re = /GourdI18n\.t\(\s*'remote\.([A-Za-z0-9_]+)'/g;
    let m;
    while ((m = re.exec(code)) !== null) keys.add(m[1]);
  }
  return keys;
}

test('i18n：12 语言包 remote.* 硬锁清单齐全', () => {
  const langs = fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'));
  assert.equal(langs.length, 12, '必须 12 个语言包');
  for (const lang of langs) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    assert.ok(data.remote, `${lang} 缺 remote 节`);
    for (const key of REMOTE_KEYS) {
      assert.ok(data.remote[key] && typeof data.remote[key] === 'string' && data.remote[key].length > 0,
        `${lang}.remote.${key} 缺失或为空`);
    }
  }
});

test('i18n：前端引用的每一个 remote.* 键必须 12 语言包全齐（从源码派生）', () => {
  const used = referencedRemoteKeys();
  assert.ok(used.size >= 40, `派生到的引用数异常偏少（${used.size}），很可能是正则失配而不是真的少`);
  for (const lang of fs.readdirSync(LOCALES).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    for (const key of used) {
      assert.ok(data.remote && data.remote[key] && String(data.remote[key]).trim().length > 0,
        `${lang}.remote.${key} 缺失：代码引用了却无人翻译（运行时会退成显示键名）`);
    }
  }
});

test('i18n：占位参数必须与代码传参一致（错了会直接显示 {host} 字面量）', () => {
  const withParams = {
    connecting_to: ['{host}', '{port}'],
    connecting_wsl: ['{distro}', '{user}'],
    reconnecting: ['{attempt}', '{max}'],
  };
  for (const lang of ['zh-CN.json', 'en.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    for (const [key, params] of Object.entries(withParams)) {
      for (const p of params) {
        assert.ok(String(data.remote[key]).includes(p), `${lang}.remote.${key} 必须保留占位 ${p}`);
      }
    }
  }
});

test('i18n：connecting_to 必须带 {host} {port} 占位（实时日志参数化）', () => {
  for (const lang of ['zh-CN.json', 'en.json', 'ja.json', 'ru.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    assert.ok(data.remote.connecting_to.includes('{host}') && data.remote.connecting_to.includes('{port}'),
      `${lang} connecting_to 必须含 {host}/{port} 占位符`);
  }
});

test('i18n：connecting_wsl 必须带 {distro} {user} 占位（P2 WSL 日志参数化）', () => {
  for (const lang of ['zh-CN.json', 'en.json', 'ja.json', 'de.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    assert.ok(data.remote.connecting_wsl.includes('{distro}') && data.remote.connecting_wsl.includes('{user}'),
      `${lang} connecting_wsl 必须含 {distro}/{user} 占位符`);
  }
});

/* ===== P2/P3：三通道向导契约 ===== */

test('P2/P3：向导三通道 tab + WSL 下拉 + 预装提示（源码结构）', () => {
  // 通道切换 tab（ssh/wsl/preinstalled）
  assert.match(remote, /remote-channel-tab/, '必须有通道 tab');
  assert.match(remote, /data-ch="wsl"/, 'WSL 通道 tab');
  /* CLI 预装通道入口屏蔽契约（2026-10-08 用户拍板「CLI 预装先屏蔽掉」）：
     后端链路（Rust connect_preinstalled/detect_preinstalled）保留，仅前端入口屏蔽。
     锁三件事：①开关存在且当前为 false（恢复时改 true）；②preinstalled tab 的渲染
     必须被该开关三元门控（不得无条件渲染）；③已保存主机的生效通道经
     effectiveChannel 降级（屏蔽期历史 preinstalled 条目按 ssh 形态打开，
     避免 wizardChannel 落到被屏蔽通道后渲染出不可达形态）。 */
  assert.match(remote, /var PREINSTALLED_CHANNEL_ENABLED = false;/,
    'CLI 预装入口屏蔽开关必须存在且当前为 false（2026-10-08 拍板屏蔽）');
  const tabSlice = sliceBetween(remote, 'PREINSTALLED_CHANNEL_ENABLED\n', "data-ch=\"preinstalled\"");
  assert.match(tabSlice, /PREINSTALLED_CHANNEL_ENABLED/, 'preinstalled tab 必须由开关三元门控渲染');
  assert.match(remote, /function effectiveChannel\(h\)/, '必须有生效通道降级函数');
  assert.match(remote, /ch === 'preinstalled' && !PREINSTALLED_CHANNEL_ENABLED/, '屏蔽期 preinstalled 必须降级');
  assert.match(remote, /wizardChannel = effectiveChannel\(h\);/, '已保存主机快选必须走 effectiveChannel');
  assert.match(remote, /var ch = effectiveChannel\(h\);/, '已保存主机列表展示必须走 effectiveChannel（标签与实际形态一致）');
  // WSL 通道仅 Windows 宿主可见；宿主判定两层：桌面壳 electronAPI.platform
  // 精确判定，浏览器直开（无桌面壳，开发调试常见）经 UA 兜底 Windows——
  // 只用 electronAPI 会在 Windows 浏览器里静默吞掉 WSL 入口（用户实测反馈）。
  assert.match(remote, /window\.electronAPI\.platform === 'win32'/, 'WSL tab 必须 gated 在 win32 宿主（方案 §五：非 Windows 宿主不出现此通道）');
  assert.match(remote, /!window\.electronAPI && \/Windows\/i\.test\(navigator\.userAgent/,
    '无桌面壳时必须用 UA 兜底 Windows（否则 Windows 浏览器里 WSL 入口静默消失）');
  // 无桌面能力时明确告知「需要桌面端」（不是漏画 WSL，而是整个远程通道不可用），
  // 且 WSL 下拉不得显示误导性的「未发现发行版」（查询根本没发出）。
  assert.match(remote, /remote-need-desktop/,
    '无桌面壳时必须显示明确说明（remote-need-desktop 横幅）');
  assert.match(remote, /hasDesktop \? '' : '<div class="remote-form-row remote-wsl-hint remote-need-desktop">'/,
    '横幅必须由 hasDesktop 能力判定驱动（有桌面壳时不出现）');
  assert.match(remote, /sel && !hasDesktop/,
    'WSL 下拉在无桌面壳时必须走 unsupported 分支（不得显示误导性的「未发现发行版」）');
  // WSL 下拉只放行 version=2（WSL1 无 localhostForwarding）
  assert.match(remote, /d\.version !== 2/, 'WSL 下拉必须过滤 version!==2 的发行版');
  // 预装模式提示文案键存在引用
  assert.match(remote, /remote\.preinstalled_hint/);
  assert.match(remote, /remote\.wsl_hint/);
});

test('P2/P3：doConnect 携带 channel 且保存快选含 channel（非敏感）', () => {
  // doConnect 前的分支构造：WSL 传 channel:'wsl'（无密码/无认证）
  const wslCall = sliceBetween(remote, "doConnect({ channel: 'wsl'", '});');
  assert.match(wslCall, /channel: 'wsl'/);
  assert.doesNotMatch(wslCall, /password|passphrase|keyPath/, 'WSL 通道是本机通道，不得携带认证字段');
  // SSH/预装分支携带 wizardChannel
  assert.match(remote, /channel: wizardChannel/);
  // 保存快选条目含 channel（去重键也含 channel）
  assert.match(remote, /h\.channel === \(cfg\.channel \|\| 'ssh'\)/, '去重键必须含 channel');
  assert.match(remote, /channel: cfg\.channel \|\| 'ssh'/, '快选条目必须含 channel');
});

test('P2/P3：remoteWslList 桥接 + 失败静默降级空数组', () => {
  assert.match(remote, /loadWslDistros/, '必须存在发行版拉取函数');
  assert.match(remote, /ipc\.remoteWslList/, '必须调用桥接 remoteWslList');
  // 静默降级：拒绝时回空数组（非 Windows 宿主 / wsl.exe 缺失）
  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /remoteWslList:\s*function/, '桥接层暴露 remoteWslList');
  assert.match(bridge, /return Array\.isArray\(v\) \? v : \[\]/, '非数组返回值归一为空数组');
});

/* ===== 本轮静态验证修复的契约（P0-A / P1-A / P1-B / P2-A~D）===== */

test('P0-A：并存语义——「打开文件夹」恒本地原生对话框，远端目录走专属入口', () => {
  const fn = sliceBetween(workspace, 'function pickSystemFolder(onPicked)', '/* 切换 chat 工作空间');
  // 并存语义（2026-10-07 拍板）：本地添加入口不因远程连接而改变——不得再有远程分支
  assert.doesNotMatch(fn, /__GOURD_REMOTE_ACTIVE__/, '本机对话框不得按远程态切换（连着远端也能加本地目录，正是并存语义）');
  assert.match(fn, /pickDirectory/, '桌面端主路径恒为本机 IPC 原生对话框');
  // 远端目录专属入口：workspace-remote-open-btn（浏览+登记全带 __scope=id）
  assert.match(workspace, /workspace-remote-open-btn/, '远端目录必须有专属入口按钮');
  const seg = sliceBetween(workspace, '.workspace-remote-open-btn', 'var item = t.closest');
  assert.match(seg, /openRemoteDirPicker/, '入口必须走远程目录选择器（带 scope 的 openDirPicker）');
  /* 2026-10-16 收编：登记 ajax 收敛到 registerWorkspacePath 单点（scopeId=rid →
     __scope=id:<rid>），入口分支不再内联 url 字面量。断言改锁「走共用链且传 rid」。 */
  assert.match(seg, /registerWorkspacePath\(picked, rid, true\)/,
    '远端登记必须走共用链且锁选定连接（scopeId=rid → __scope=id；下拉入口 autoSelect=true 保持登记完顺势选中）');
  // openDirPicker 支持 scope 参数（app-code.js），browse 强制打到指定连接
  const code = fs.readFileSync(path.join(STATIC, 'js', 'app-code.js'), 'utf8');
  assert.match(code, /function openDirPicker\(onPick, scopeQ\)/, 'openDirPicker 必须支持 scope 参数');
  /* 【行为级断言，不再锁措辞】旧版断言写死 `(scopeQ || '')` 这段拼串——
     它恰好把缺陷形态锁成了契约：scopeQ 以 `&` 起头，而首次浏览 p 为空时 URL 里没有 `?`，
     拼出来是 `/browse&__scope=id:x`——服务端按 `?` 切分取不到 scope（代理回落激活上游），
     路径也多出一段（404）。锁措辞的断言会把这条错误路径永远钉住，
     改成「必须经 browseQuery 且它保证 `?` 开头」才锁得住真实行为。 */
  assert.match(code, /browseQuery\(p, scopeQ\)/, 'browse 请求必须经 browseQuery 拼 query');
  assert.match(code, /browseQuery\(p, scopeQ\)/, 'browse 请求必须经 browseQuery 拼 query');
  /* endMark 用不含换行的下一个函数头：工作树是 CRLF（git i/lf w/crlf），
     用 `\n    }\n` 这类含裸 \n 的标记在 CRLF 下永远匹不上（\r\n 里没有 "}\n"），
     会报「结束标记必须存在」而看起来像实现缺失。 */
  const bq = sliceBetween(code, 'function browseQuery(p, scopeQ)', 'function openDirPicker');
  /* 锁行为而非锁措辞：输出必须是 `?` 开头且各段用 `&` 连接。
     不能写成 assert.match(bq, /\?/)——切片里正则字面量本身、注释、三元都含 `?`，
     那样是恒真断言（绿色假象），变异回旧拼串也照样通过。 */
  assert.match(bq, /return parts\.length \? \('\?' \+ parts\.join\('&'\)\) : ''/,
    'browseQuery 必须产出 `?a=1&b=2` 形态（无参数时空串，不留裸 `?`）');
  assert.match(bq, /if \(p\) parts\.push\('path=' \+ encodeURIComponent\(p\)\)/,
    'path 必须经 encodeURIComponent（路径含空格/中文时不能碎成多段）');
  assert.match(bq, /replace\(\/\^\[&\?\]\/, ''\)/,
    'scopeQ 的前导分隔符必须剥掉再重组（调用方传的是 `&__scope=...`）');
  assert.doesNotMatch(code, /browse' \+ \(p \? '\?path=/,
    '不得回到旧拼串形态（首次浏览 p 为空时丢 `?`，scope 被当成路径段）');
  // 激活探针存在（app-remote.js 定义，按钮渲染门控用）
  assert.match(remote, /window\.__GOURD_REMOTE_ACTIVE__\s*=\s*function/, '远程态探针必须由 app-remote.js 导出');
});

test('P0-A：projects/add 登记必须校验 body.code（Solon 失败也是 HTTP 200）', () => {
  /* 2026-10-16 收编：三个登记入口（add-btn / 消歧候选 / 侧栏分组头「＋」）共用
     registerWorkspacePath——body.code 校验与临时 _scope 记录单点，消灭「同一条
     缺陷的两个副本」（历史上 add-btn 与消歧各抄一份内联 ajax，修一处漏一处）。
     计数断言因此翻转：校验点必须恰好 1 处（多处 = 内联副本回流）。 */
  const okChecks = (workspace.match(/resp && resp\.code !== 200/g) || []).length;
  assert.equal(okChecks, 1,
    `body.code 校验必须收敛到 registerWorkspacePath 单点，实际 ${okChecks} 处（多处 = 内联副本回流）`);
  const reg = sliceBetween(workspace, 'function registerWorkspacePath(picked, scopeId, autoSelect)', 'window.sidebarAddWorkspace');
  assert.match(reg, /resp && resp\.code !== 200/, '单点必须校 body.code（只校 .done() 会静默选中幽灵路径）');
  const calls = (workspace.match(/registerWorkspacePath\(/g) || []).length;
  assert.ok(calls >= 4, '定义 + 至少三个调用点（add-btn/消歧/分组头两分支），实际=' + calls);
});

test('P1-A：应用退出必须清理远端后端进程（shutdown_all 定义 + RunEvent::Exit 接线）', () => {
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /pub async fn shutdown_all\(\)/, 'shutdown_all 必须定义（main.rs 调用它，缺了直接编译失败）');
  assert.match(modRs, /async fn destroy_connection\(conn: &RemoteConnection\)/,
    '销毁体必须抽函数：disconnect 与退出清理共用，分写两遍会出现「正常断开干净、退出残留」');
  // 限时兜底：SSH 半开时 exec(kill) 会阻塞到 TCP 超时，不能让用户关不掉应用
  assert.match(modRs, /const SHUTDOWN_PER_CONN_TIMEOUT_SECS/, '每条连接必须独立限时');
  // 限时包裹销毁体（注意写法是先 `let fut = destroy_connection(...)` 再 timeout 包裹，
  // 所以断言得按「先取 fut、后被 timeout 包住」的实际顺序，不能反过来）
  assert.match(modRs, /let fut = destroy_connection\(&conn\);[\s\S]{0,400}tokio::time::timeout\([\s\S]{0,200}SHUTDOWN_PER_CONN_TIMEOUT_SECS/, '限时包裹销毁体');
  const mainRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'main.rs'));
  assert.match(mainRs, /RunEvent::Exit =>[\s\S]{0,700}remote::shutdown_all\(\)\.await/,
    'Exit 分支必须真的 await shutdown_all（写在其它分支等于没接）');
});

test('P1-B：模型镜像结果必须推前端事件（不能只写日志）', () => {
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /"remote-mirror-state"[\s\S]{0,200}"line": line/,
    '进度行必须经 remote-mirror-state 事件外推（镜像发生在向导关闭后，连接日志通道已无消费者）');
  assert.match(modRs, /"done": true,\s*"synced": synced/,
    '终态必须单独一帧（前端据此决定要不要打扰用户）');
  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /onRemoteMirror:\s*function\s*\(cb\)\s*\{\s*on\('remote-mirror-state', cb\);/, '桥接层暴露订阅');
  // 前端消费：失败要打扰、成功静默、只认当前连接
  assert.match(remote, /onRemoteMirror/, '前端必须订阅镜像事件');
  const handler = sliceBetween(remote, 'onRemoteMirror(function (payload)', '}\n    }');
  assert.match(handler, /payload\.synced\) return/, '成功静默（每次连接弹“同步成功”是噪声）');
  assert.match(handler, /connectionsById\[payload\.connectionId\]/,
    '守卫必须是注册表存在性（方案B：任一在线连接镜像失败都要报；不在注册表的旧尾帧不报）');
  assert.match(handler, /remote\.mirror_auto_failed/, '失败必须有可读懂的提示键');
});

test('P2-A：#remoteKeyBrowse「浏览」必须真接线到原生文件对话框（四层）', () => {
  // 死 UI 回归锁：按钮渲染了却零绑定（点了什么也不会发生）
  assert.match(remote, /querySelector\('#remoteKeyBrowse'\)/, '必须取到浏览按钮');
  assert.match(remote, /keyBrowse\.addEventListener\('click'[\s\S]{0,400}ipc\.pickFile\(\)/,
    '点击必须调 ipc.pickFile 并回填 remoteKeyPath');
  assert.match(remote, /typeof ipc\.pickFile !== 'function'/, '非桌面环境静默降级（保留手填）');

  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /pub async fn pick_file\(app: AppHandle\)/, 'Rust 命令定义');
  assert.match(bridge, /invoke\('pick_file'\)/, '桥接层暴露');
  assert.match(bridge, /blocking_pick_file\(\)/, '必须用 blocking API（与 pick_directory 同口径）');
  const mainRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'main.rs'));
  assert.match(mainRs, /ipc_bridge::pick_file,/, 'main.rs 注册');
  const buildRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'build.rs'));
  assert.ok(buildRs.includes('"pick_file"'), 'build.rs COMMANDS 登记（否则远程源 ACL 静默拒绝）');
  const caps = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'capabilities', 'default.json'));
  assert.ok(caps.includes('"allow-pick-file"'), 'capabilities 授权');
});

test('P2-B：连接状态展现面收敛到分组树（全局徽标已下线；动作菜单改挂分组头）', () => {
  /* 2026-10-16 产品拍板：支持同时连多台远端，logo 行右侧单个全局徽标只能报
     「其中一台/台数」，与侧栏分组树（本地组 + 每连接一组 + 在线状态点）信息
     重复且更弱 → 徽标整体删除。连接级动作（同步镜像/重连/断开）不随之消失：
     菜单本体保留，入口改挂分组头「⋯」（openRemoteConnMenu）。 */
  assert.doesNotMatch(remote, /window\.refreshRemoteBadge/, '徽标渲染器不得残留（零调用点即死接口）');
  assert.doesNotMatch(remote, /remoteStateBadge/, '徽标 DOM id 不得残留');
  const menu = sliceBetween(remote, 'function openRemoteConnMenu(anchor, connId)', 'function menuActsHtml');
  assert.match(menu, /ensureRemoteMenu\(\)/, '菜单本体必须保留（复用 #remoteMenu 弹层与关闭链）');
  assert.match(menu, /if \(!connId \|\| !connectionsById\[connId\]\) return/,
    '连接不存在必须静默返回（分组头⋯只渲染在线/掉线组，这里是第二道闸）');
  assert.match(menu, /data-conn-id="/ , '动作必须绑定到具体连接（菜单不再按连接分组）');
  assert.match(remote, /window\.openRemoteConnMenu = openRemoteConnMenu/,
    '分组头入口必须暴露到 window（app-history 跨闭包调用）');
  /* CSS 配套：徽标规则必须随实现一起删（留着就是死规则 + 误导后人） */
  assert.doesNotMatch(appCss, /\.remote-badge \{/, '.remote-badge 规则必须已删除');
  assert.doesNotMatch(appCss, /\.sidebar-header-top \.remote-badge/, '侧栏头部徽标占位规则必须已删除');
});

test('P2-C：启动恢复的主机展示名取自 Rust 回传（不得拿已保存列表第一项猜）', () => {
  /* 【codereview 2026-10-10】回退链抽为 tryRestoreViaStateChain 后，host/user 取值在
     函数体内（restoreOnBoot 锚点之前）：切片起点改函数头、终点改其后第一个 IIFE 收尾。 */
  const at = remote.indexOf('function tryRestoreViaStateChain');
  assert.ok(at > 0, '启动恢复块必须存在');
  const raw = remote.slice(at, remote.indexOf('})();', at));
  /* 注释先剔掉：本处修复的说明里引用了旧写法 savedHosts()[0]（为了后人看懂为何要这么改），
      不剔就会把自己的注释当成回归——“测自己的注释”是这类源码扫描断言的通病。 */
  const seg = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(seg, /savedHosts\(\)/, '代码里不得用 savedHosts()[0]：它是「最近连过的主机」，不等于「当前连接」——多主机时报错机器');
  assert.match(seg, /host: \(st && st\.host\) \|\| ''/, 'host 取 remoteState 回传值');
  assert.match(seg, /user: \(st && st\.user\) \|\| ''/, 'user 取 remoteState 回传值');
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /"host": conn\.control\.display_host\(\)/, 'state_of 必须回传真实展示名');
  assert.match(modRs, /"user": conn\.control\.display_user\(\)/, 'state_of 必须回传用户');
});

test('并存语义：切换上游只刷新列表不动选择；断开/探活失败仅选着远端时回位', () => {
  /* 【连接 ≠ 切换环境】（2026-10-07 拍板，ZCode 语义）连上远端不清选择：
     用户选着的本地工作区继续有效，列表双拉合并后远端条目自然可见。
     refreshContextForChannel 只重拉列表（notifyProjectsChanged + loadSessionHistory），
     不得再碰 applyChatWorkspace（那会把正在用的本地选择清掉）。 */
  const at = remote.indexOf('function refreshContextForChannel');
  assert.ok(at > 0, '必须有通道切换后的上下文刷新函数');
  const seg = remote.slice(at, remote.indexOf('function applyConnection'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(seg, /applyChatWorkspace/,
    '连接建立不得清空/回改当前工作区选择（并存语义的核心红线）');
  assert.match(seg, /notifyProjectsChanged\(\)/, '必须广播项目表变更（合并列表双拉）');
  assert.match(seg, /loadSessionHistory\(\)/, '必须重拉会话列表（合并展示两源）');

  /* 断开/探活失败：仅当选着远端工作区（__lastRemoteWorkspace）时回位到空选择。
     选择记忆由 app-workspace 的 selectChatWorkspace 维护（window.__lastRemoteWorkspace）。 */
  const discSeg = remote.slice(remote.indexOf('function doDisconnect'), remote.indexOf('/* ================= WSL'));
  assert.match(discSeg, /__lastRemoteWorkspace/, '断开必须按「是否选着远端」分流回位');
  assert.match(discSeg, /applyChatWorkspace\('', true\)/, '选着远端时断开必须回空选择（silent）');
  assert.match(remote, /window\.__lastRemoteWorkspace/, '选择记忆经 window 暴露（模块闭包外可读）');
  assert.match(workspace, /window\.__lastRemoteWorkspace = sel/, 'selectChatWorkspace 必须维护远端选择记忆');

  /* code 模式：断开时若选着远端项目，同样复位（文件树/已开文件指远端磁盘） */
  assert.match(discSeg, /resetCodeProjectForChannel/,
    '选着远端时断开必须复位 code 模式项目（否则保存会写到已死隧道）');
  const codeJs = fs.readFileSync(path.join(STATIC, 'js', 'app-code.js'), 'utf8');
  const defAt = codeJs.indexOf('function resetCodeProjectForChannel(connectionId)');
  assert.ok(defAt > 0, 'app-code.js 必须导出复位函数（closeAllFiles/projName 是本文件私有作域，外部无法自己干）');
  const defSeg = codeJs.slice(defAt, defAt + 1400); /* 参数化后函数体变长（归属判定前置），700 窗口装不下收尾三动作 */
  assert.match(defSeg, /window\.currentProjectRoot = ''/);
  assert.match(defSeg, /closeAllFiles\(\);/, '必须真关文件（Monaco model 释放 + 标签清空）');
  assert.match(defSeg, /GourdI18n\.t\('code\.select_project'\)/, '选择器文案要回到未选态');
});

test('P2-D：向导文案必须与实际能力一致（JRE 自装链已落地）', () => {  for (const lang of ['zh-CN.json', 'en.json']) {
    const data = JSON.parse(fs.readFileSync(path.join(LOCALES, lang), 'utf8'));
    assert.doesNotMatch(data.remote.wsl_hint, /JDK 17/,
      'wsl_hint 不得再声称「要求已装 JDK 17+」——现在无 java 会自动装 JRE 17');
    assert.match(data.remote.wsl_hint, /JRE 17/, '必须描述 JRE 自装语义');
    assert.doesNotMatch(data.remote.preinstalled_hint, /JAVA_TOOL_OPTIONS/,
      '预装提示不得再指 JAVA_TOOL_OPTIONS（凭据已改走环境变量，避开 Picked up 日志泄漏）');
    /* 徽标下线后 badge_title/badge_count 必须不存在（死键不得回流） */
    assert.equal(data.remote.badge_title, undefined, 'badge_title 已随徽标下线，不得回流');
    assert.equal(data.remote.badge_count, undefined, 'badge_count 已随徽标下线，不得回流');
  }
});

/* ===== 按工作区分流（用户 2026-10-06 拍板，方案 §十二）=====
   目标：本地工作区与远程工作区并存，不再「一连远端就整机切过去」。
   分流在代理层完成（前端不改写地址、不包 fetch/ajax）。 */

const serverRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'server.rs'));

test('分流：路由表三级结构齐备（active / by_id / by_cwd）', () => {
  assert.match(serverRs, /struct RemoteRoute \{[\s\S]*?active: Option<\(u16, String\)>/,
    '必须保留激活 scope（无归属信息请求的默认去处）');
  assert.match(serverRs, /by_id: HashMap<String, \(u16, String\)>/, '连接维表');
  assert.match(serverRs, /by_cwd: HashMap<String, \(u16, String\)>/, '工作区路径维表');
  for (const api of ['pub fn register_remote_connection', 'pub fn bind_scope',
    'pub fn unregister_remote_connection', 'pub fn reset_remote_route', 'fn route_for']) {
    assert.ok(serverRs.includes(api), `路由 API 缺失: ${api}`);
  }
});

test('分流：route_for 必须守住「带 cwd 未绑定 = 本地」这条安全栏', () => {
  const body = serverRs.split('fn route_for')[1].split('/// 从 query 里取 cwd')[0];
  /* 不能用「首次出现 RouteDecision::Local」定位：函数开头 RwLock poisoned 分支就是
     `return RouteDecision::Local`（Rust 单测已实测行为正确，此处仅断言结构顺序）。 */
  const atBind = body.indexOf('by_cwd.get');
  assert.ok(atBind > 0, '必须查 by_cwd');
  const atLocalAfterBind = body.slice(atBind).indexOf('RouteDecision::Local');
  assert.ok(atLocalAfterBind > 0, '绑定未命中之后必须紧跟回本地分支');
  const atActive = body.indexOf('g.active');
  assert.ok(atActive > atBind + atLocalAfterBind,
    '激活 scope 只能作为无归属信息的兜底，不能盖过 cwd 判定（否则本地目录串到远端）');
});

test('分流：scope_key 对 POSIX 保留大小写（不能一律 lowercase）', () => {
  /* macOS/Linux 桌面 + Linux 远端都是大小写敏感文件系统：/home/u/Proj 与
     /home/u/proj 是两个真实目录。归一时合并会把本地目录的请求误路由到远端。 */
  const fn = serverRs.split('fn scope_key')[1].split('lazy_static')[0];
  assert.match(fn, /to_ascii_lowercase\(\)/, 'Windows 形式仍需小写归一（NTFS 大小写不敏感）');
  assert.match(fn, /is_drive \|\| is_unc/, 'lowercase 必须被限定在 Windows 风格路径分支内');
  assert.doesNotMatch(fn, /let s = [^\n]*\.to_ascii_lowercase\(\)[^\n]*\n\}/,
    '不得在函数末尾无条件 lowercase（那会把 POSIX 路径一并抹掉大小写）');
});

test('分流：remote_bind_scope 命令四层接线齐备', () => {
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /pub async fn remote_bind_scope\(cwd: String, connection_id: Option<String>\)/,
    '必须两个参数：只给激活环境不够，连着远端选本地目录会被误绑（跳机读写）');
  const mainRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'main.rs'));
  assert.ok(mainRs.includes('remote::remote_bind_scope'), 'main.rs 注册');
  const buildRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'build.rs'));
  assert.ok(buildRs.includes('"remote_bind_scope"'), 'build.rs COMMANDS 登记（否则远程源 ACL 静默拒绝）');
  const caps = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'capabilities', 'default.json'));
  assert.ok(caps.includes('"allow-remote-bind-scope"'), 'capabilities 授权');
  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /remoteBindScope: function \(cwd, connectionId\)/, '桥接层暴露');
  assert.match(bridge, /invoke\('remote_bind_scope', \{[\s\S]*?connectionId:/, '必须透传 connectionId');
});

test('分流：选中工作区必须声明归属并重连长连接（时序硬约束）', () => {
  const fn = workspace.split('function bindWorkspaceScope')[1].split('/* 切换 chat 工作空间')[0];
  assert.match(fn, /ipc\.remoteBindScope\(path \|\| '', id\)/, '必须同时传目录与归属 id');
  /* 归属来源的具体口径（条目 _scope 优先、查不到才回落实时探针）由下一条用例专门锁；
     本用例只守「探针存在 + 调用时序」，不再重复锁定归属取法（上一版在这重复审
     并因重构误红，结构断言重叠 = 改一处挂两处）。 */
  assert.match(workspace, /window\.__GOURD_REMOTE_ACTIVE_ID__\(\)/, '必须经 app-remote 导出的实时探针取激活环境');
  assert.match(fn, /ok === false[\s\S]{0,200}showToast/, '绑定失败必须提示（静默吞会得到「目录存在但发消息必败」）');
  assert.match(remote, /window\.__GOURD_REMOTE_ACTIVE_ID__ = function/, 'app-remote 必须导出归属探针');

  // 时序：声明归属必须在 currentChatWorkspace 赋值之前（后续拉取都依赖它）；
  // 而 gate 重连必须在赋值之后（否则带的是旧 cwd）。
  /* 切片前先 lf() 归一：结束标记含裸 `\n` + 固定缩进，CRLF 工作树下永远切不开，
     `[0]` 会退化成「函数头之后整个文件」——indexOf 到后面别的函数里也能命中，
     时序断言因此假绿（看起来在锁顺序，实际什么都没锁）。 */
  const sel = lf(workspace).split('function selectChatWorkspace')[1].split('\n    }\n')[0];
  /* 真切开守卫：旧写法 `sel.length < lf(workspace).length` 是恒真式（split[1]
     已剥掉标记前的非空内容，[0] 必然短于全文）——切不开时它也过。真守卫应
     针对退化形态本身：切开后若还含下一个顶层函数定义，说明结束标记未命中、
     sel 实际是「函数头之后的整个文件」，此时序断言无意义，直接失败。 */
  assert.ok(!/^function /m.test(sel) && !/^async function /m.test(sel),
    '函数体切片必须真切开（sel 里不得再含顶层 function 定义，否则时序断言无意义）');
  const atBind = sel.indexOf('bindWorkspaceScope(sel)');
  const atAssign = sel.indexOf('window.currentChatWorkspace = sel;');
  const atGate = sel.indexOf('connectWebGate');
  assert.ok(atBind > 0 && atAssign > atBind, '归属声明必须先于赋值（赋值后会广播 workspace:changed 触发拉取）');
  assert.ok(atGate > atAssign, 'gate 重连必须后于赋值：否则 /web/gate 的 ?cwd= 带的是旧目录');
});

test('分流：WS 两面必须带 cwd（浏览器 WS 无法带自定义头，query 是唯一归属通道）', () => {
  const streaming = fs.readFileSync(path.join(STATIC, 'js', 'app-streaming.js'), 'utf8');
  const gate = streaming.split('var protocol = (window.location.protocol')[1].slice(0, 900);
  assert.match(gate, /getSessionCwd\(\)/, 'gate 必须取当前工作区');
  assert.match(gate, /'\/web\/gate'[\s\S]{0,200}\?cwd=/, 'gate URL 必须拼 ?cwd=');
  const terminal = fs.readFileSync(path.join(STATIC, 'js', 'app-terminal.js'), 'utf8');
  assert.match(terminal, /'\?cwd=' \+ encodeURIComponent\(root\)/, 'terminal 本就有 ?cwd=（分流可直接复用）');
});

test('分流：探活失败/断开必须整条摘除路由（不能只清激活值）', () => {
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  const probe = modRs.split('fn spawn_health_probe')[1].split('// 前端连接请求')[0];
  assert.match(probe, /unregister_remote_connection\(&connection_id\)/,
    '探活失败必须整条摘除：只 clear 激活值会留下「列表回本地、远端工作区仍打已死隧道」的半死形态（全 502 且无提示）');
  const disc = modRs.split('pub async fn disconnect')[1].split('/// 查询连接状态')[0];
  assert.match(disc, /unregister_remote_connection\(connection_id\)/, '正常断开同样整条摘除');
  const shut = modRs.split('pub async fn shutdown_all')[1].split('/// 查询连接状态')[0];
  assert.match(shut, /reset_remote_route\(\)/, '退出清理走整表重置');
  assert.ok(!/clear_remote_override\(\)/.test(probe + disc),
    '两条路径不得再调 clear_remote_override（多连接并存时会误删其它连接）');
});

test('断开必须一次清零引用（releaseAll 三处贯通：前端→桥接→Rust）', () => {
  /* 【P1 回归】同一台远端开多个工作区时 refs>1（connect 里复用 +1）。旧版无论
     怎么断都只减 1：用户点「断开」后徒远端后端继续跑（白占服务器内存），
     而徽标已消失（前端先置 null）——既无提示也无重试入口，只能重启应用才能
     收尾远端进程。UI 的「断开」语义是「断开这台主机」，故必须一次清零。 */
  const discSeg = sliceBetween(remote, 'function doDisconnect', '/* ================= WSL');
  assert.match(discSeg, /remoteDisconnect\((id|target), true\)/,
    '前端必须传 releaseAll=true（只减 1 会让多工作区的断开静默失效）');
  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  const bSeg = bridge.split('remoteDisconnect: function')[1].split('},')[0];
  assert.match(bSeg, /releaseAll/, '桥接层必须透传 releaseAll（Tauri 按驼峰映射手参数）');
  const modRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'remote', 'mod.rs'));
  assert.match(modRs, /pub async fn remote_disconnect\(\s*connection_id: String,\s*release_all: Option<bool>,/,
    'Rust 命令必须接住第二个参数');
  // UI 默认口径 = 整条释放（宁可不传也不能少杀，少杀 = 远端孤儿进程常驻）
  assert.match(modRs, /release_all\.unwrap_or\(true\)/,
    '命令层默认必须为 true（旧壳不传参数时也得把远端进程收尾干净）');
  // 清零用 fetch_update（而非先读后写：中间窗口可能有人 +1）
  const fnSeg = modRs.split('pub async fn disconnect(')[1].split('/// 应用退出清理')[0];
  assert.match(fnSeg, /fetch_update/, '一次清零必须用原子 fetch_update，不能先 load 再 store');
});

test('分流：双拉合并——主拉恒本地 + 远端经 __scope=id（并存语义核心）', () => {
  /* 主拉取必须显式 __scope=local：无归属请求走激活 scope，而激活会随「选中远端
     工作区」漂移——主拉结果不能当本地那份用。远端那份经 __scope=id:<rid> 且
     connectionId 必须 encodeURIComponent（代理侧 urlpercent_decode 查表）。 */
  const fn = workspace.split('function loadProjects(cb)')[1].split('function renderSelectors')[0];
  assert.match(fn, /\$\.get\('\/web\/chat\/projects\?__scope=local'\)/,
    '主拉取必须显式 __scope=local（恒本地，不随激活漂移）');
  assert.match(fn, /\$\.get\('\/web\/chat\/projects\?__scope=id:' \+ encodeURIComponent\(activeId\)\)/,
    '远端拉取必须带 __scope=id 且 encodeURIComponent（冒号→%3A，代理解码查表）');
  assert.match(fn, /_scope/, '每条项目必须带来源标记（绑定按来源而非按激活环境）');
  assert.match(fn, /projectsCache\.concat\(merged\)/, '本地在前、远端在后（「默认环境是本地」的心智）');
  // 绑定自愈：settle 后选中远端工作区时重声明归属（路由表丢失后不用等用户重点）
  assert.match(fn, /scope !== 'local'/, '自愈只对远端归属触发（本地幂等、无选择无意义）');
  // 两次拉取都必须结算，否则远端拉失败会卡住整个列表
  assert.match(fn, /var done = 0;/, '双请求计数收口');
  assert.ok((fn.match(/\.always\(settle\)/g) || []).length === 2,
    '两个请求都必须接 settle（只接一个会永不调回调 → 下拉一直转圈）');
  /* 本地登记与远端登记都必须显式 scope：/web/chat/projects/add 无 cwd 归属，
     不带 scope 会打到激活环境（可能指向远端 → 本地路径在远端不存在，登记失败）。
     2026-10-16 收编后 scope 串在 registerWorkspacePath 单点拼装（q 三目），
     断言改锁拼装点；并反向锁「不得再有内联 url 字面量」（单点纪律）。 */
  const reg = sliceBetween(workspace, 'function registerWorkspacePath(picked, scopeId, autoSelect)', 'window.sidebarAddWorkspace');
  assert.match(reg, /'\?__scope=local'/, '本地登记必须带 __scope=local');
  assert.match(reg, /'\?__scope=id:' \+ encodeURIComponent\(scopeId\)/, '远端登记必须带 __scope=id 且 encodeURIComponent');
  assert.doesNotMatch(workspace, /url: '\/web\/chat\/projects\/add\?/,
    '登记 ajax 不得再内联 scope 字面量（单点纪律：出现即复制实现回流）');
});

test('分流：绑定必须按条目来源而非激活环境（合并列表下否则会把本地项误绑远端）', () => {
  const fn = workspace.split('function bindWorkspaceScope(path)')[1].split('/* 切换 chat 工作空间')[0];
  assert.match(fn, /var id = scopeOfPath\(path\)/, '归属必须取自条目自带的 _scope');
  assert.doesNotMatch(fn, /var id = \(typeof window\.__GOURD_REMOTE_ACTIVE_ID__/, '不得直接拿激活环境当归属');
  assert.match(fn, /if \(!id \|\| id === 'local'\) id = null/, "null 与 'local' 必须归一为 null（与 Rust 侧语义一致）");
  const probe = workspace.split('function scopeOfPath(path)')[1].split('function bindWorkspaceScope')[0];
  assert.match(probe, /p\._scope/, '查表取来源');
  /* 【方案B 契约翻转】scopeOfPath 查不到回 null（不再回落激活环境）：回落是跨机
     误绑根因（连第二台后第一台已选目录被改绑新连接）。过渡期由临时 _scope 记录承担。 */
  assert.match(probe, /return null;/, '查不到必须回 null（调用方按 local 处理）');
  assert.doesNotMatch(probe, /__GOURD_REMOTE_ACTIVE_ID__/, '不得回落激活环境');
});

test('分流：既有整机切换语义作为兜底保留（零回归）', () => {
  /* 路由表为空时一切回本地；无归属信息的请求（列表/meta）走激活 scope。
     这两条保证不连远端时行为与改造前完全一致，也保证旧壳/浏览器端不退化。 */
  const body = serverRs.split('fn route_for')[1].split('/// 从 query 里取 cwd')[0];
  assert.match(body, /match &g\.active \{[\s\S]*?RouteDecision::Remote[\s\S]*?RouteDecision::Local/,
    '激活 scope 兜底必须仍在（兼容整机切换 + 旧行为）');
  /* 【P0 回归】本地分支不得回读激活覆盖：旧断言锁的是「本地端口解析必须优先读
     覆盖」，那条要求本身就是缺陷（route_for 判出 Local 又被拽回远端 → 本地
     列表/设置被远端顶掉），故翻转：决策只能有一个真相源（route_for）。
     切片前 lf() 归一（同上：CRLF 下 `\n}\n` 切不开，负向断言的范围会失真）。 */
  const decision = lf(serverRs).split('fn upstream_for(')[1].split('\n}\n')[0];
  /* 真切开守卫：旧写法与 sel 处同理是恒真式。决策函数体里切开后若还含
     下一个顶层 fn 定义，说明 `\n}\n` 未命中、decision 是「函数头后的整个
     文件」，负向断言 !/remote_[Oo]verride/ 的范围就失真了（去扫到别的函数）。 */
  assert.ok(!/^fn |^async fn |^pub fn /m.test(decision),
    '决策函数体必须真切开（decision 里不得再含顶层 fn 定义，否则范围失真）');
  assert.ok(decision.includes('route_for('), '上游必须由 route_for 单一入口决定');
  assert.ok(!/remote_[Oo]verride/.test(decision),
    '决策函数的本地分支不得回读激活覆盖（否则强制本地的请求被拽回远端）');
});

/* ===== 向导交互：面板内点击不得误关 + 表单对齐（实测回归锁定） ===== */

const appCss = fs.readFileSync(path.join(STATIC, 'css', 'app.css'), 'utf8');

/** 取某个选择器对应的规则块体（验证行为，不把「属性顺序」当契约） */
function cssRuleBlock(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc.replace(/\s/g, '\\s*') + '\\s*\\{([^}]*)\\}', 'g');
  let m, found = null;
  while ((m = re.exec(css)) !== null) found = m[1];
  assert.ok(found !== null, 'CSS 规则必须存在: ' + selector);
  return found;
}

test('向导：遮罩命中判定为纯函数，面板内元素一律不算点了背景', () => {
  const seg = sliceBetween(remote, 'function isWizardMaskHit', 'function closeWizard');
  const api = new Function(seg + '\nreturn { isWizardMaskHit: isWizardMaskHit };')();
  const backdrop = { tag: 'backdrop' };
  // 缺陷复现：closest 沿祖先链上溯，遮罩是面板的祖先——面板内任何元素都会命中。
  // 纯函数只认「按下点 === 遮罩本体」，面板子节点必须为 false。
  assert.equal(api.isWizardMaskHit({ tag: 'panel-child' }, backdrop), false,
    '面板内元素（非遮罩本体）不得判定为点背景');
  assert.equal(api.isWizardMaskHit(backdrop, backdrop), true, '点遮罩本体必须判定为点背景');
  assert.equal(api.isWizardMaskHit(null, backdrop), false, '空 target 不得关闭');
  assert.equal(api.isWizardMaskHit(backdrop, null), false, '向导未挂载时不得抛错/关闭');
});

/* 取纯代码文本（剔除块注释与整行注释）：源码里写「绝不能用 closest(...)」这类
   反例说明是给人看的，不应被「残留必须清零」的字符串护栏误判为真使用。 */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('向导：关闭绑定用 mousedown + 祖先链判定残留必须清零', () => {
  const code = codeOnly(remote);
  // 旧写法 closest('.remote-wizard-backdrop') 会命中面板内每个元素（遮罩是祖先），
  // 导致点输入框/私钥 tab/跳板机/记住密码均关掉整个向导——不得回退。
  assert.doesNotMatch(code, /closest\('\.remote-wizard-backdrop'\)/,
    '不得再用 closest 判定遮罩点击（祖先链命中=面板内一点就关）');
  assert.match(code, /addEventListener\('mousedown'/,
    '遮罩关闭必须绑 mousedown（面板内按下、遮罩上松手的选文字场景不得误关）');
  assert.match(code, /isWizardMaskHit\(e\.target,\s*el\)/, 'mousedown 处理必须走纯函数判据');
});

test('向导：Escape 可关闭，但输入法组字时不得关闭', () => {
  /* 不用含字面 \n + 固定缩进的 sliceBetween 定位：那种锁定对行尾风格（app-remote.js
     现为 LF，而 core.autocrlf=true 下次 checkout 可能转为 CRLF）与缩进调整都敏感，
     属于会误报的脆弱护栏。改用空白无关正则，只取 Escape 回调体。 */
  const m = remote.match(/addEventListener\('keydown',\s*function\s*\(e\)\s*\{([\s\S]*?)\}\s*\);/);
  assert.ok(m, '必须存在 Escape 关闭向导的 keydown 监听');
  const seg = m[1];
  assert.match(seg, /e\.isComposing/, '组字（IME 候选）时 Esc 语义是取消候选词，不得关掉向导');
  assert.match(seg, /closeWizard\(\)/, '非组字 Esc 必须关闭向导');
});

test('向导：通用输入框样式必须排除 checkbox（否则勾选框被拉成整行长条、文案换行错位）', () => {
  // 实测缺陷：width:100% 落在 checkbox 上把 13px 勾选框撑成 89.3px，
  // 连带「记住凭据」文案折成三行（label 高 48px）。
  const block = cssRuleBlock(appCss, '.remote-form-row input:not([type="checkbox"])');
  assert.match(block, /width:\s*100%/,
    '必须有排除 checkbox 的全宽输入框规则');
  assert.ok(!/^\.remote-form-row input\s*\{[^}]*width:\s*100%/m.test(appCss),
    '不得保留命中 checkbox 的裸 .remote-form-row input 宽度规则');
  assert.match(appCss, /\.remote-form-row input:not\(\[type="checkbox"\]\):focus/,
    'focus 描边同样不得作用于 checkbox（否则勾选框获得输入框外观）');
});

test('向导：记住密码行定高单行（勾选框 flex:none + 文案 nowrap）', () => {
  assert.match(cssRuleBlock(appCss, '.remote-remember input[type="checkbox"]'), /flex:\s*none/,
    '勾选框不得被 flex 容器拉伸');
  assert.match(cssRuleBlock(appCss, '.remote-remember input[type="checkbox"]'), /width:\s*14px/,
    '勾选框尺寸必须显式定尺');
  assert.match(cssRuleBlock(appCss, '.remote-remember'), /white-space:\s*nowrap/,
    '文案不得换行（换行=错位）');
  assert.match(cssRuleBlock(appCss, '.remote-remember-row'), /flex-wrap:\s*nowrap/,
    '整行不得换行');
});

test('向导：连接进度日志必须置 block（空串不匹配 [style*="block"] 契约，日志会一直隐藏）', () => {
  assert.doesNotMatch(remote, /getElementById\('remoteConnectLog'\)\.style\.display\s*=\s*''\s*;/,
    "不得用 display='' ：CSS 靠 [style*=\"block\"] 提升优先级，空串会让进度日志永不显示");
  assert.equal((remote.match(/getElementById\('remoteConnectLog'\)\.style\.display = 'block';/g) || []).length, 2,
    'WSL 与 SSH 两条连接路径都必须显式 block');
});

/* ===== 收尾守门（本轮踩到的两类“测试绿但运行死”形态）===== */

test('收尾：分流改动过的每个 JS 文件必须能被真实解析（语法完好）', () => {
  /* 两类事故都真实发生过：①注释块里写 `jump_` 加星号加斜杠的组合会提前终止注释
     → 整个文件语法坏；②整块替换吞掉相邻函数头（doConnect 定义丢了）。
     两者用「读文本 + 正则」的契约测试全部发现不了，必须过一遍解析器。 */
  // 【本轮补】app-base.js（新增 pathScopeKey）与 app-history.js（双拉去重改归一）
  // 同样被改过：漏一个就是「语法坏了没人报」的盲区（历史上真发生过两次）
  for (const name of ['app-remote.js', 'app-workspace.js', 'app-streaming.js', 'app-code.js',
    'app-base.js', 'app-history.js']) {
    const src = fs.readFileSync(path.join(STATIC, 'js', name), 'utf8');
    assert.doesNotThrow(() => new Function(src), `${name} 语法解析失败`);
  }
});

test('收尾：本轮改过的文件必须全部列入镜像同步清单', () => {
  /* 镜像护栏只对列入的文件生效。本轮 app-streaming.js（gate 拼 ?cwd=）被改过却没列入，
     就是「改了源不跑 prepare-ui 也没人报」的盲区——因此把清单与本轮改动集对齐后本身也要锁。 */
  const self = fs.readFileSync(__filename, 'utf8');
  const at = self.indexOf('镜像与 static 源同步');
  assert.ok(at > 0, '同步用例必须在');
  const list = self.slice(at, at + 1500);
  for (const name of ['app-remote.js', 'app-workspace.js', 'app-streaming.js', 'app-code.js',
    'app-base.js', 'app-history.js', 'app.css']) {
    assert.ok(list.includes(`'${name}'`), `${name} 本轮被改过但未列入同步清单`);
  }
});

/* ===== tauri/ui 镜像同步（存在镜像时才比对） ===== */
test('gourd-ai-tauri/ui 镜像与 static 源同步（本批 8 文件）', () => {
  const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
  if (!fs.existsSync(mirrorRoot)) return; // CI 干净检出无镜像
  const files = [
    ['js', 'app-remote.js'],
    ['js', 'app-workspace.js'],
    ['js', 'app-bootstrap.js'],
    /* 【本轮补】pathScopeKey 新增在 app-base.js（全站唯一口径，最先加载且无 IIFE），
       双拉去重改归一在 app-history.js：不列入就等于桌面壳跑的是旧副本，而本地
       大小写不同的两个目录仍会被误合并（护栏只对列入的文件生效）。 */
    ['js', 'app-base.js'],
    ['js', 'app-history.js'],
    /* app-code.js 本轮因通道切换复位（resetCodeProjectForChannel）被改；不在清单里
       就等于改了源不跑 prepare-ui 也没人报（镜像护栏只对列入的文件生效）。
       app-streaming.js 同理（gate 拼 ?cwd= 属于分流改动）。 */
    ['js', 'app-code.js'],
    ['js', 'app-streaming.js'],
    ['css', 'app.css'],
    ['index.html'],
  ];
  for (const parts of files) {
    const rel = parts.join('/');
    const mirror = fs.readFileSync(path.join(mirrorRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
    const src = fs.readFileSync(path.join(STATIC, ...parts), 'utf8').replace(/^\uFEFF/, '');
    assert.equal(mirror, src, `gourd-ai-tauri/ui 副本不同步，请运行 node gourd-ai-tauri/cmd/prepare-ui.js: ${rel}`);
  }
});

/* ===== 远程连接入口按钮的视觉契约（颜色统一 + 图标语义） ===== */
/* 背景：工作空间下拉底部两个动作项是并列可选动作。旧写法把「远程连接」降为
   --text-secondary（占位期 disabled 的遗留），与「打开文件夹」的 --accent 分属两套
   色，看起来像禁用残留；图标误用「中心圆 + 8 条放射短线」（太阳/loader 形状），
   与远程语义无关。本轮统一到 --accent 并换成云形图标，以下断言防再次跑偏。 */
const codeCss = fs.readFileSync(path.join(STATIC, 'css', 'code.css'), 'utf8');

function ruleBody(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, '缺少规则: ' + selector);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(close > open, '规则体未闭合: ' + selector);
  return css.slice(open + 1, close);
}

function colorDecl(body, label) {
  const m = body.match(/color:\s*var\([^)]*\)/);
  assert.ok(m, label + ' 必须有 color: var(...) 声明');
  return m[0];
}

test('code.css：下拉动作项文字色/hover 底色由基类统一承载（防暗色漏色不可见）', () => {
  /* 历史缺陷：color 分散声明在各按钮类上，新增「打开远程目录」漏声明 →
     <button> 走 UA 默认 ButtonText（近黑），暗色主题黑字黑底不可见。
     故契约翻转为：基类必须有 color: var(--accent) 与 hover 底色，
     且各动作项个别类不得再自定 color（两套色=禁用残留观感，漏色=暗色不可见）。 */
  const baseColor = colorDecl(ruleBody(codeCss, '.workspace-action-btn {'), '动作项基类');
  assert.match(baseColor, /var\(--accent\)/,
    '基类文字色必须是 --accent（并列动作同权重，且暗色主题下可见）');
  assert.match(ruleBody(codeCss, '.workspace-action-btn:hover {'),
    /background:\s*var\(--bg-hover\)/, 'hover 底色须挂基类，所有动作项悬停反馈对称');
  for (const sel of ['.workspace-add-btn {', '.workspace-remote-btn {', '.workspace-remote-open-btn {']) {
    const at = codeCss.indexOf(sel);
    if (at >= 0) {
      assert.doesNotMatch(ruleBody(codeCss, sel), /(^|[^-])color:/,
        sel + ' 不得自定文字色（基类已统一承载，个别声明必漏新按钮）');
    }
  }
  // 三个动作项按钮在 JS 里都必须带基类（漏带即再次回到 UA 默认色）
  for (const cls of ['workspace-add-btn', 'workspace-remote-open-btn', 'workspace-remote-btn']) {
    assert.match(workspace, new RegExp('workspace-action-btn ' + cls), cls + ' 必须与基类同挂');
  }
});

test('app-workspace.js：远程连接图标为云形，且与文件夹图标同规格', () => {
  const svg = sliceBetween(workspace, 'workspace-remote-btn\">', '</svg>');
  const addSvg = sliceBetween(workspace, 'workspace-add-btn\">', '</svg>');
  assert.doesNotMatch(svg, /M12 1v6/, '不得回退太阳/loader 放射线图标');
  assert.doesNotMatch(svg, /<circle/, '云形为单条 path，放射线图标里的 circle 不得回来');
  assert.match(svg, /path d=\"M17\.5 19H9a7 7 0 1 1/, '必须是云轮廓 path');
  // 与相邻「打开文件夹」图标同尺寸同描边（视觉同族）
  for (const attr of ['width=\"14\"', 'height=\"14\"', 'viewBox=\"0 0 24 24\"',
    'stroke=\"currentColor\"', 'stroke-width=\"2\"', 'stroke-linecap=\"round\"',
    'stroke-linejoin=\"round\"']) {
    assert.ok(svg.includes(attr), '图标规格须与文件夹图标一致: ' + attr);
    assert.ok(addSvg.includes(attr), '对照：文件夹图标应含同一属性: ' + attr);
  }
});

/* ===== 离线/内网改造一期：离线运行时包链契约 =====
   四层链：向导选择器（app-remote.js）→ 桥接键（ipc_bridge.rs BRIDGE_JS）→
   Rust 命令参数（remote/mod.rs remote_connect）→ 解析链消费（runtime_pkg_path）。
   任何一层断链都会让「内网用户选了包却没生效」静默发生，故逐层锁。 */

const TAURI_SRC = path.resolve(__dirname, '../../../../gourd-ai-tauri/src-tauri/src');
const TAURI_ROOT = path.resolve(__dirname, '../../../../gourd-ai-tauri');

function readTauri(rel) {
  return fs.readFileSync(path.join(TAURI_SRC, rel), 'utf8');
}

test('离线包链：向导有选择行 + 浏览按钮 + 提示键引用', () => {
  assert.match(remote, /id="remoteRuntimePkg"/, '向导必须有离线包路径输入框');
  assert.match(remote, /id="remoteRuntimeBrowse"/, '必须有浏览按钮（死 UI 禁令）');
  assert.match(remote, /remote\.runtime_pkg_label/, 'placeholder 必须走 i18n');
  assert.match(remote, /remote\.runtime_pkg_hint/, '必须有说明行（用户得知道留空的后果）');
  // 浏览接线：与私钥同款 pickFile（非桌面环境静默降级手填）
  const seg = sliceBetween(remote, 'remoteRuntimeBrowse', "el.querySelector('.remote-wizard-close')");
  assert.match(seg, /pickFile/, '浏览按钮必须接 pickFile');
  assert.match(seg, /remoteRuntimePkg/, '选中后必须回填到离线包输入框');
});

test('离线包行视觉形态：输入+浏览并排成组 + hint 降级（防回退旧三行堆叠）', () => {
  /* 2026-10-08 用户实测反馈旧形态「好丑」：浏览按钮独占一行、说明与输入同权重。
     新形态锁三条：① 输入+按钮同处 .remote-file-row 并排；② 整行 .remote-optional-row
     减权；③ 说明走 .remote-optional-hint（11px），不得复用必填行说明的 .remote-wsl-hint。 */
  /* 行级 class 在 id 之前（<div class="..." id="...">），sliceBetween 从 id 起切会
     把 class 切掉——故减权类用全源锚点断言，行内结构用 slice 断言。 */
  assert.match(remote, /remote-form-row remote-optional-row" id="remoteRuntimeRow"/, '可选行必须有减权类');
  const rowSeg = sliceBetween(remote, 'id="remoteRuntimeRow"', 'remote-jump-toggle');
  assert.match(rowSeg, /remote-file-row/, '输入与浏览按钮必须并排成组');
  assert.match(rowSeg, /remote-optional-hint/, '说明必须走降级 hint 类');
  assert.doesNotMatch(rowSeg, /remote-wsl-hint/, '可选行说明不得复用必填行说明类（同字号会喧宾夺主）');
  // 私钥行同族（两个浏览按钮视觉必须一致，不允许各写一套）
  const keySeg = sliceBetween(remote, 'id="remoteKeyRow"', 'remoteConnectBtn');
  assert.match(keySeg, /remote-file-row/, '私钥行也必须用同款成组形态');
  // CSS 侧：并排 grid + 按钮与输入同高语言 + hint 字号
  assert.match(appCss, /\.remote-file-row \{ display: grid; grid-template-columns: 1fr auto;/, '成组必须并排 grid');
  // 同高用 stretch 自适配（硬编码 px 会因字体度量浮动裂 1px，实测 34 vs 33）
  assert.match(appCss, /\.remote-file-row \{[^}]*align-items: stretch;/, '成组必须 stretch 保证同高');
  assert.match(appCss, /\.remote-file-row \.remote-key-browse \{[^}]*height: auto/, '浏览按钮高度必须自适配');
  assert.match(appCss, /\.remote-optional-hint \{ font-size: 11px;/, 'hint 必须 11px 降级');
  assert.match(appCss, /\.remote-optional-row input::placeholder \{ color: var\(--text-secondary\)/, '可选行 placeholder 减权');
  // 旧的双套浏览按钮样式必须已合并（防并存冲突）
  assert.doesNotMatch(appCss, /#remoteKeyRow \.remote-key-browse \{/, '私钥浏览按钮独立样式必须已并入 .remote-file-row');
});

test('离线包链：提交参数 runtimePkgPath 透传（前端→桥接→Rust 三层逐字对齐）', () => {
  // 前端 doConnect 的 cfg 带 runtimePkgPath（取自输入框 trim）
  assert.match(remote, /runtimePkgPath:/, 'doConnect cfg 必须带 runtimePkgPath');
  // 桥接 invoke 参数
  const bridge = readTauri('ipc_bridge.rs');
  assert.match(bridge, /runtimePkgPath:/, 'BRIDGE_JS invoke 必须透传 runtimePkgPath');
  // Rust 命令形参 + ConnectParams 字段 + 解析链消费
  const mod = readTauri(path.join('remote', 'mod.rs'));
  assert.match(mod, /runtime_pkg_path: Option<String>/, 'remote_connect 形参必须有 runtime_pkg_path');
  assert.match(mod, /pub runtime_pkg_path: Option<String>/, 'ConnectParams 必须有该字段');
  assert.match(mod, /params\.runtime_pkg_path\.as_deref\(\)/, '解析链必须消费该参数（SSH 通道）');
  // WSL 通道同样消费（两通道语义一致）
  const uses = (mod.match(/runtime_pkg_path\.as_deref\(\)/g) || []).length;
  assert.ok(uses >= 2, `SSH 与 WSL 两通道都应消费离线包参数，实际 ${uses} 处`);
});

test('离线包链：运行时资产名三处一致（Rust 取件名 = 制作脚本产出名 = CI 产物名）', () => {
  const mod = readTauri(path.join('remote', 'mod.rs'));
  assert.match(mod, /runtime-\{\}\.tar\.gz/, 'Rust 侧资产名模板');
  assert.match(mod, /"linux-x64"/, 'x64 tag');
  assert.match(mod, /"linux-aarch64"/, 'aarch64 tag');
  // P0-2 防复发：取件必须落在 runtimes/ 子目录（tauri.conf 映射与制作脚本产出同口径；
  // 旧实现拼在 resources 根 → 发布版 L1 静默失效、内网远端被推去无网的 L4）
  assert.match(mod, /base\.join\("runtimes"\)\.join\(format!\("runtime-\{\}\.tar\.gz", tag\)\)/,
    'Rust 取件必须走 runtimes/ 子目录');
  // P1-2 防复发：platform 门禁（macOS 远端 uname -m 同为 x86_64/aarch64，只判 arch 会上传 linux 资产）
  assert.match(mod, /if platform != "Linux"/, '内置资产只服务 Linux 远端');
  const make = fs.readFileSync(path.join(TAURI_ROOT, 'cmd', 'make-runtime-linux.js'), 'utf8');
  assert.match(make, /runtime-linux-' \+ archTag \+ '\.tar\.gz/, '制作脚本产出名必须与 Rust 取件名同构');
  // Windows 下必须钉死 System32 bsdtar：CI 的 shell: bash 把 Git Bash 的 /usr/bin
  // 前置到 PATH，裸 'tar'/'tar.exe' 命中的是 GNU tar，它把 D:\a\... 盘符冒号解析为
  // 「远程主机 D」（tar (child): Cannot connect to D: resolve failed），曾阻断 CI 打包。
  assert.match(make, /function resolveTar\(\)\s*\{[\s\S]*?System32/, 'Windows 下必须用 resolveTar() 钉死 System32 bsdtar');
  assert.ok((make.match(/resolveTar\(\)/g) || []).length >= 4,
    'resolveTar 必须覆盖全部 tar 调用点（定义 1 处 + 解宿主 zip + 解 jmods + 打包 ≥3 处）');
  assert.doesNotMatch(make, /execFileSync\((?:'tar'|"tar")/, '禁止裸 tar：Windows/PATH 解析会命中 Git Bash GNU tar');
  assert.doesNotMatch(make, /\bprocess\.platform === 'win32' \? 'tar\.exe' : 'tar'/, '禁止三元回退裸 tar.exe：PATH 上前置的是 GNU tar');
  // tauri.conf resources 映射 runtimes/ 目录（资产进安装包）
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI_ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const res = Object.keys(conf.bundle.resources).join('|');
  assert.match(res, /runtimes\//, 'bundle.resources 必须映射 runtimes/ 目录');
  // CI 必须产出该资产（三腿）
  const wf = fs.readFileSync(path.resolve(__dirname, '../../../../.github/workflows/build-tauri.yml'), 'utf8');
  assert.match(wf, /make-runtime-linux\.js/, 'CI 必须调用制作脚本');
});

test('离线包链：解析链顺序 L0→L3a→L3b→门禁→L1→L4（源码序）', () => {
  const mod = readTauri(path.join('remote', 'mod.rs'));
  const i0 = mod.indexOf('deploy::java_usable(env)');
  const i3a = mod.indexOf('deploy::preset_runtime_usable(env)');
  const i3b = mod.indexOf('user_pkg_path.filter');
  const igate = mod.indexOf('deploy::libc_gate(');
  const i1 = mod.indexOf('bundled_runtime_asset(crate::paths::resources_dir(), &env.platform, &env.arch)');
  const i4 = mod.indexOf('remote_self_install_jre(');
  for (const [n, v] of [['L0', i0], ['L3a', i3a], ['L3b', i3b], ['gate', igate], ['L1', i1], ['L4', i4]]) {
    assert.ok(v > 0, `解析链缺 ${n} 环节`);
  }
  assert.ok(i0 < i3a && i3a < i3b && i3b < igate && igate < i1 && i1 < i4,
    `解析链顺序必须 L0<L3a<L3b<门禁<L1<L4：${[i0, i3a, i3b, igate, i1, i4]}`);
  // 门禁只保护 L1/L4（glibc 构建资产）：门禁与内置资产取件之间不得有上传；
  // L3b 用户自备包刻意绕过门禁（用户对自己资产负责），其上传在门禁前是设计而非缺陷。
  const gateToL1 = mod.slice(igate, i1);
  assert.doesNotMatch(gateToL1, /deploy_runtime/, '门禁与 L1 之间不得有上传动作');
  assert.match(mod.slice(i3b, igate), /deploy_runtime/, 'L3b 用户包上传在门禁前（刻意绕过，用户自担）');
});

test('离线包链：detect v2 十字段 + 版本门禁（Rust 源码契约）', () => {
  const dep = readTauri(path.join('remote', 'deploy.rs'));
  assert.match(dep, /parts\.len\(\) < 10/, 'parse_detect 必须要求 10 字段');
  assert.match(dep, /java -version 2>&1 \| grep -v '\^Picked up' \| head -1/, 'detect 脚本必须探 java 版本首行且滤 JAVA_TOOL_OPTIONS 噪声');
  // P0-1 防复发：验收门禁按 kind 分叉（jar 包无 bin/java，共用运行时门禁必死 NO_JAVA_IN_TAR）
  assert.match(dep, /enum DeployKind/, '部署物种类枚举必须存在');
  assert.match(dep, /NO_JAR_IN_TAR/, 'jar 包验收标记必须存在');
  assert.match(dep, /getconf GNU_LIBC_VERSION/, 'detect 脚本必须探 glibc');
  assert.match(dep, /MIN_JAVA_MAJOR/, '版本门禁常量必须存在');
  // 旧假成功判据不得复活：ensure 入口不得以 java.is_some() 单独短路
  const mod = readTauri(path.join('remote', 'mod.rs'));
  const seg = sliceBetween(mod, 'async fn ensure_remote_runtime', 'L3a');
  assert.doesNotMatch(seg, /if env\.java\.is_some\(\) \{\s*return Ok/, '不得以「有 java」单独短路（Java 8 假成功）');
});

/* ===== WSL 通道：-e 直 exec + 内部发行版过滤（bad substitution 复发护栏） ===== */

test('WSL：exec 必须 -e 直 exec（默认 shell 预解析 bad substitution 复发护栏，Rust 源码契约）', () => {
  const wsl = readTauri(path.join('remote', 'wsl.rs'));
  const seg = sliceBetween(wsl, 'async fn exec_with_shell', 'let output = child.wait_with_output()');
  assert.match(seg, /"-e", shell, "-ls"/, 'exec 必须 -e 直 execvp（默认 shell 不得预解析命令体）');
  assert.match(wsl, /res\.exit_code == 126 \|\| res\.exit_code == 127/,
    'bash 缺失（126/127）必须回退 /bin/sh（Alpine 系发行版无 bash）');
  assert.doesNotMatch(wsl, /\$\{PIPESTATUS\[0\]\}/,
    '旧包装器 bashism 不得复活（ash 系 bad substitution 全通道灭 / bash 系屏蔽退出码）');
});

test('WSL：bash 缺失回退必须认 wsl.exe 的 execvpe 失败（真机 exit=1，只看 126/127 会漏）', () => {
  /* 【P1 真机取证 2026-10-13】docker-desktop（Alpine/ash，无 bash）下
     `wsl.exe -d docker-desktop -e /bin/bash -ls` 实测返回 **exit=1**，stderr 为
     `<3>WSL (pid - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed: ...`。
     126/127 是「shell 已起来后 execvp 失败」的语义，而 -e 直 exec 是 wsl.exe 自己
     去 execvp，失败归到 wsl.exe 进程退出码 1 —— 旧判据因此漏掉真正的无-bash
     场景，回退永不触发，ash 系发行版全通道灭。 */
  const wsl = readTauri(path.join('remote', 'wsl.rs'));
  assert.match(wsl, /fn shell_unavailable\(res: &ExecResult, shell: &str\) -> bool/,
    '必须有独立的 shell 不可用判据函数（可单测，不内联在 exec 里）');
  const body = sliceBetween(wsl, 'fn shell_unavailable(', 'res.stderr.contains(&needle)');
  assert.match(body, /execvpe\(\{\}\) failed/,
    '判据必须匹配 wsl.exe 的 execvpe(<shell>) failed 形态（真机 exit=1 的唯一线索）');
  assert.match(body, /format!\("execvpe/,
    'execvpe 判定必须锚定目标 shell 路径（否则业务命令的 not found 会被误判成无 bash，回退毫无意义）');
  assert.match(wsl, /if shell_unavailable\(&res, "\/bin\/bash"\)/,
    'exec 回退分支必须走该判据（不得回退到只看退出码）');
});

test('WSL：UNC 上传必须先探可达性（root 家目录 0700 经 9P 无权，不得白跑必败的写 + 刷 warn）', () => {
  const wsl = readTauri(path.join('remote', 'wsl.rs'));
  /* 切片要含到 cat 保底段为止（旧写法定在 `// 2. cat 流式` 注释之前，正好把
     要校的 cat 路径排除在外，自己把自己的断言判红了）。 */
  const seg = sliceBetween(wsl, 'pub async fn upload', 'let output = child.wait_with_output()');
  assert.match(seg, /let unc_reachable = match unc\.parent\(\)/,
    '必须先探 UNC 父目录可达性（create_dir_all 探路）');
  assert.match(seg, /if unc_reachable \{/,
    'UNC 分块写必须被可达性门控（不可达直接走 cat 流式保底）');
  assert.match(seg, /tracing::info!/,
    '不可达是预期内权限限制，必须 info 级（warn 会让排障者误当真故障）');
  assert.match(seg, /UNC 路径不可达/,
    '不可达日志必须带可读原因（常见于 root 家目录）');
  // cat 保底路径必须仍在（探路判错也不能丢上传能力）
  assert.match(seg, /cat > /, 'cat 流式保底路径不得因门控而消失');
});

test('WSL 向导：Docker Desktop 内部发行版不得进下拉与预选', () => {
  assert.match(remote, /function isInternalWslDistro\(name\)/, '内部发行版判定函数必须存在');
  assert.match(remote, /docker-desktop\(-data\)\?/,
    '判定正则必须覆盖 docker-desktop 与 docker-desktop-data 两形态');
  assert.match(remote, /if \(isInternalWslDistro\(d\.name\)\) continue;/,
    '下拉填充必须跳过内部发行版（musl/ash/ephemeral，连上必然失败）');
  const seg = sliceBetween(remote, 'var usable = list.filter', 'if (picked && picked.defaultUser)');
  assert.match(seg, /!isInternalWslDistro\(d\.name\)/,
    '预选候选集必须同口径排除内部发行版（不得自动预选不可用发行版）');
});
