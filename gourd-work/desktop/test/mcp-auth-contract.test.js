/* ===== MCP 连接器认证前端契约 =====
 *
 * 与 mcp-market-contract.test.js 同一套加载方式：node:test + fs 读真实源码，
 * 另用 vm 跑 MCP-AUTH-MODULE 代码块，配最小 jQuery / window 桩，真正执行
 * 弹窗生成与端点调用，而不是只数字符串。
 *
 * 五条最低断言：
 *   (1) 源码里有 window.McpAuth 与 /web/settings/mcp/auth/start；
 *   (2) password 输入是 type="password" 而非 text；
 *   (3) window.open 打开后端返回的 authorizationUrl；
 *   (4) 轮询 /auth/status 且提供 /auth/cancel；
 *   (5) token 提交到 /auth/token，且没有任何把 token 写进配置 / settings.json 的代码。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const UI = path.resolve(__dirname, '..', 'ui');
const read = p => fs.readFileSync(path.join(UI, p), 'utf8');

const settingsSrc = read('js/app-settings-mcp.js');
const marketSrc = read('js/app-mcp-market.js');
const cssSrc = read('css/mcp-auth.css');
const html = read('index.html');
const zh = JSON.parse(read('locales/zh-CN.json')).settings.mcp;
const en = JSON.parse(read('locales/en.json')).settings.mcp;

/** 只取认证模块代码块（实现按要求放在先加载的 app-settings-mcp.js 里）。 */
const START = '/* MCP-AUTH-MODULE-START */';
const END = '/* MCP-AUTH-MODULE-END */';
function authBlock() {
  const i = settingsSrc.indexOf(START);
  const j = settingsSrc.indexOf(END);
  assert.ok(i >= 0 && j > i, 'app-settings-mcp.js 缺 MCP-AUTH-MODULE 代码块');
  return settingsSrc.slice(i, j + END.length);
}

test('① window.McpAuth 挂在 app-settings-mcp.js，六个端点齐全', () => {
  assert.match(settingsSrc, /window\.McpAuth\s*=\s*\{/, '必须在先加载的 app-settings-mcp.js 里定义 window.McpAuth');
  assert.match(settingsSrc, /MCP-AUTH-MODULE-START/, '模块块标记缺失');
  ['state', 'start', 'status', 'cancel', 'token', 'clear'].forEach(p => {
    assert.ok(settingsSrc.includes("'/web/settings/mcp/auth/" + p + "'"), '缺 /auth/' + p + ' 路径');
  });
  assert.match(settingsSrc, /\/web\/settings\/mcp\/auth\/start/, '缺 /auth/start 调用');
  // 市场侧必须通过 window.McpAuth || {} 兜底，不重复实现
  assert.match(marketSrc, /window\.McpAuth\s*\|\|\s*\{\}/, '市场模块未用 window.McpAuth || {} 兜底');
  assert.match(settingsSrc, /openDialog:\s*openDialog/, 'McpAuth 未导出 openDialog');
  assert.match(settingsSrc, /openBrowser:\s*openBrowser/, 'McpAuth 未导出 openBrowser');
});

test('② token 输入是 type="password"，且 helpUrl 是可点击外链', () => {
  const block = authBlock();
  assert.match(block, /<input type="password" id="mcpAuthTokenInput"/, 'token 输入必须遮蔽');
  assert.doesNotMatch(block, /id="mcpAuthTokenInput"[^>]*type="text"/, '不得退回明文 text 输入');
  assert.match(block, /target="_blank" rel="noopener noreferrer"/, 'helpUrl 外链必须带 noopener');
  assert.match(block, /\^https\?:\\\/\\\//i, 'helpUrl 只放行 http(s) 协议');
  assert.match(block, /\$\('#mcpAuthTokenInput'\)\.val\(''\)/, '保存成功后必须清空明文输入');
  assert.match(block, /authT\('auth_save_and_connect'/, '按钮文案必须走 i18n');
});

test('③ OAuth：window.open 立即打开后端返回的 authorizationUrl', () => {
  const block = authBlock();
  assert.match(block, /function openBrowser\(url\)[\s\S]*?window\.open\(url, '_blank', 'noopener,noreferrer'\)/,
    '必须用 window.open(url, _blank, noopener,noreferrer) 交给桌面壳转系统浏览器');
  assert.match(block, /r\.authorizationUrl/, '必须使用 /auth/start 返回的 authorizationUrl');
  assert.match(block, /showWaiting\(name, r\.authorizationUrl, onDone\)/, 'start 成功后必须进入等待弹窗');
  assert.match(block, /openBrowser\(url\);/, '等待弹窗内必须立刻调用 openBrowser');
  // 桌面壳靠 on_new_window 钩子转交；不能退化成 location.href 应用内导航
  assert.doesNotMatch(block, /location\.href\s*=\s*url/, '不得在应用窗口内导航到授权页');
});

test('④ 每 1.5s 轮询 /auth/status，支持 cancel，5 分钟超时', () => {
  const block = authBlock();
  assert.match(block, /var POLL_MS = 1500/, '轮询间隔必须是 1.5s');
  assert.match(block, /var MAX_WAIT_MS = 5 \* 60 \* 1000/, '超时上限必须是 5 分钟');
  assert.match(block, /API\.status \+ '\?name=' \+ encodeURIComponent\(name\)/, '缺 /auth/status?name= 轮询请求');
  assert.match(block, /setTimeout\(tick, POLL_MS\)/, '未安排下一轮轮询');
  assert.match(block, /cancel\(name\)/, '取消按钮未调 /auth/cancel');
  assert.match(block, /phase === 'done'/, '未处理 done');
  assert.match(block, /phase === 'failed' \|\| phase === 'cancelled'/, '未处理 failed / cancelled 并允许重试');
  assert.match(block, /authT\('auth_timeout'/, '超时文案必须走 i18n');
});

test('⑤ token 只走 /auth/token，绝不写进服务器配置 / settings.json', () => {
  const block = authBlock();
  assert.match(block, /token:\s*'\/web\/settings\/mcp\/auth\/token'/, '缺 /auth/token 路径');
  assert.match(block, /request\(API\.token, 'POST', \{ name: name, token: value \}\)/,
    'token 必须只出现在 /auth/token 的一次请求体里');
  // 保存/更新请求体里不得出现任何 token 字段
  const bodyFn = /function buildMcpBodyObj\(\)[\s\S]*?return bodyObj;/.exec(settingsSrc);
  assert.ok(bodyFn, '无法定位 buildMcpBodyObj（测试前提失效）');
  // 行为级判据（旧断言 /token/i 会误伤合法的 authType='token' 声明）：
  // 认证声明是配置、不是密钥，允许且必须提交 authType；真正禁止的是把
  // 用户输入的凭据「值」写进配置请求体。
  assert.match(bodyFn[0], /bodyObj\.auth\s*=\s*\{\s*authType:/,
    '表单必须提交 auth.authType 声明，否则 /auth/state 恒为 none，弹窗空转');
  assert.doesNotMatch(bodyFn[0], /bodyObj\.(token|apiKey|api_key|secret|password|credential)\s*=/i,
    'buildMcpBodyObj 里混入了凭据值字段（会写进 settings.json）');
  assert.doesNotMatch(bodyFn[0], /mcpAuthTokenInput/,
    'buildMcpBodyObj 不得读取 token 输入框的值');
  assert.doesNotMatch(bodyFn[0], /bodyObj\.auth\s*=\s*\{[^}]*\bvalue\b/,
    'auth 声明里不得携带凭据值');
  assert.doesNotMatch(settingsSrc, /data:\s*JSON\.stringify\([^)]*token/, '保存 AJAX 请求体里带了 token');
  assert.doesNotMatch(block, /token[\s\S]{0,80}servers\/add/, '不得把 token 塞进 MCP 保存接口');
  // 不回显：没有把 value 写回输入框 / toast / 任何渲染字符串
  assert.doesNotMatch(block, /val\(value\)|text\(value\)|html\(value\)/, 'token 不得回显到界面');
  // 市场安装请求体同样不含凭据
  assert.doesNotMatch(marketSrc, /body:\s*JSON\.stringify\([^)]*token/, '市场安装请求体不得携带 token');
});

test('⑥ 两个入口都按 /auth/state 分流，authType=none 保持原行为', () => {
  assert.match(settingsSrc, /auth\.openDialog\(/, '手动表单保存未接认证分流');
  assert.match(marketSrc, /auth\.openDialog\(/, '市场安装未接认证分流');
  assert.match(marketSrc, /auth\.state\(id\)/, '市场侧未用 /auth/state 判断分支');
  assert.match(marketSrc, /auth\.openDialog\(name,/, '安装后必须用后端返回的真实 installed 名称查询认证态（不是市场 id）');
  assert.match(marketSrc, /data\.installed/, '缺 installed 名称解析');
  assert.match(authBlock(), /if \(kind === 'none'\) return true/, 'authType=none 必须立即放行');
  assert.match(authBlock(), /st\.needsAuth && kind === 'token'/, 'token 分支判据缺失');
  assert.match(authBlock(), /st\.needsAuth && kind === 'oauth'/, 'oauth 分支判据缺失');
  // 已连接 / 重新连接 / 清除凭据
  assert.match(authBlock(), /openManageDialog/, '缺已连接管理弹窗');
  assert.match(authBlock(), /clear\(name\)/, '缺 /auth/clear 调用');
});

test('⑦ i18n：zh-CN / en 的 auth_* 系列齐全，本地存储承诺可见', () => {
  const keys = [
    'auth_token_label', 'auth_get_token', 'auth_local_only', 'auth_token_placeholder',
    'auth_token_required', 'auth_save_and_connect', 'auth_connect_title', 'auth_waiting',
    'auth_browser_hint', 'auth_failed', 'auth_timeout', 'auth_connected',
    'auth_reconnect', 'auth_clear', 'common_cancel', 'common_close', 'network_error',
  ];
  keys.forEach(k => {
    assert.equal(typeof zh[k], 'string', 'zh-CN 缺 settings.mcp.' + k);
    assert.equal(typeof en[k], 'string', 'en 缺 settings.mcp.' + k);
  });
  assert.match(zh.auth_local_only, /本机/, '中文需声明仅本机存储');
  assert.match(zh.auth_local_only, /不会上传云端/, '中文需声明不上传云端');
  assert.match(en.auth_local_only, /only on this machine/, '英文需声明仅本机存储');
  assert.match(en.auth_local_only, /never uploaded/, '英文需声明不上传云端');
  assert.ok(zh.market && en.market, '原有 settings.mcp.market 不得被破坏');
});

test('⑧ CSS 单独文件、mcp-auth- 前缀、html 已引入', () => {
  assert.match(html, /<link rel="stylesheet" href="css\/mcp-auth\.css">/, 'index.html 未引入 mcp-auth.css');
  const bootstrap = read('js/app-bootstrap.js');
  const iSettings = bootstrap.indexOf("'/js/app-settings-mcp.js'");
  const iMarket = bootstrap.indexOf("'/js/app-mcp-market.js'");
  assert.ok(iSettings > 0 && iMarket > iSettings, 'app-settings-mcp.js 必须先于 app-mcp-market.js 加载');
  ['mcp-auth-overlay', 'mcp-auth-input', 'mcp-auth-status-dot', 'mcp-auth-error',
    'mcp-auth-btn-primary', 'mcp-auth-help-link'].forEach(c =>
    assert.ok(cssSrc.includes('.' + c), 'CSS 缺 .' + c));
  // 所有类选择器都用统一前缀（不改 import-* 原样式）
  const stripped = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const classSelectors = stripped.match(/\.[a-zA-Z][\w-]*/g) || [];
  classSelectors.forEach(c => assert.match(c, /^\.mcp-auth-/, 'CSS 类前缀不统一: ' + c));
  assert.doesNotMatch(stripped, /\.import-(overlay|dialog)/, '不得复写原 import 弹窗样式');
  assert.match(stripped, /var\(--accent\)/, '主按钮应走主题令牌 --accent');
  assert.match(stripped, /var\(--bg-input-box\)/, 'password 输入底色应走 --bg-input-box');
});

/* ===== 运行时护栏：vm 真实执行认证模块，断言 DOM 字符串与 ajax 端点 ===== */
function loadAuthModule(responder) {
  const appended = [];
  const ajaxCalls = [];
  const opened = [];
  const timers = [];
  const handlers = {};
  const elements = {};

  function jq(sel) {
    if (elements[sel]) return elements[sel];
    const o = {
      _sel: sel, _value: '',
      append(h) { appended.push({ sel, html: h }); return o; },
      on(ev, fn) { (handlers[sel + ':' + ev] = handlers[sel + ':' + ev] || []).push(fn); return o; },
      text(v) { o._text = v; return o; },
      html(v) { o._html = v; return o; },
      val(v) { if (v === undefined) return o._value; o._value = v; return o; },
      prop() { return o; }, attr() { return o; }, css() { return o; },
      removeClass() { return o; }, addClass() { return o; },
      hide() { return o; }, show() { return o; }, toggle() { return o; },
      remove() { return o; }, focus() { return o; }, trigger(ev) {
        (handlers[sel + ':' + ev] || []).forEach(f => f({ key: 'Enter', target: {} })); return o;
      },
      find() { return jq(sel + ' .find'); }, filter() { return jq(sel + ' .filter'); },
      closest() { return jq(sel + ' .closest'); }, each() { return o; },
    };
    elements[sel] = o;
    return o;
  }
  jq.ajax = opts => {
    ajaxCalls.push({ url: opts.url, method: opts.method, data: opts.data });
    const chain = {
      done(fn) { Promise.resolve().then(() => fn(responder(opts))); return chain; },
      fail() { return chain; },
      always() { return chain; },
    };
    return chain;
  };
  jq.get = () => ({ fail() {} });

  const i18nMap = {
    'settings.mcp.auth_token_label': 'Access Token',
    'settings.mcp.auth_get_token': '如何获取 Access Token？',
    'settings.mcp.auth_local_only': '仅存储在本机，不会上传云端',
    'settings.mcp.auth_save_and_connect': '保存并连接',
    'settings.mcp.common_cancel': '取消',
    'settings.mcp.common_close': '关闭',
    'settings.mcp.auth_waiting': '正在等待授权…',
    'settings.mcp.auth_browser_hint': '请在浏览器中完成授权',
    'settings.mcp.auth_connect_title': '连接授权',
    'settings.mcp.market.connect': '连接',
    'settings.mcp.market.retry': '重试',
  };
  const sandbox = {
    console, Promise, Date, JSON, encodeURIComponent,
    // URL：showQrModal 用 new URL() 校验 https（见 app-settings-mcp.js）。
    // 缺了它，oauth+qrModal 分流的 https 校验会因 ReferenceError 一律失败。
    URL, String, Number, Math, RegExp, Error,
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    $: jq,
    GourdI18n: { t(k) { return i18nMap[k] || k; } },
    window: {
      open(url, target, features) { opened.push({ url, target, features }); return null; },
      GourdI18n: { t(k) { return i18nMap[k] || k; } },
      showToast() {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(authBlock(), sandbox, { filename: 'app-settings-mcp.js#McpAuth' });
  return { sandbox, McpAuth: sandbox.window.McpAuth, appended, ajaxCalls, opened, timers, elements, jq };
}

test('⑨ 运行时：window.McpAuth 导出 8 个复用函数', () => {
  const h = loadAuthModule(() => ({ ok: true }));
  assert.ok(h.McpAuth, '未导出 window.McpAuth');
  ['state', 'start', 'status', 'cancel', 'token', 'clear', 'openDialog', 'openBrowser']
    .forEach(k => assert.equal(typeof h.McpAuth[k], 'function', 'McpAuth 缺 ' + k));
  assert.equal(h.McpAuth.POLL_MS, 1500);
  assert.equal(h.McpAuth.MAX_WAIT_MS, 300000);
});

test('⑩ 运行时：token 分支渲染出 password 输入 + 外链 + 本地存储文案', async () => {
  const h = loadAuthModule(opts => {
    if (/\/auth\/state/.test(opts.url)) return {
      ok: true, name: 'dnb', authType: 'token', connected: false, needsAuth: true,
      hasCredential: false, label: 'D&B Access Token',
      helpUrl: 'https://example.com/token', helpText: '仅存储在本机，不会上传云端',
      phase: 'idle', error: null,
    };
    return { ok: true };
  });
  const proceed = await h.McpAuth.openDialog('dnb', () => {});
  assert.equal(proceed, false, 'needsAuth 时必须由弹窗接管，不得直接提交保存');
  const dialogHtml = (h.appended.find(a => a.sel === 'body') || {}).html || '';
  assert.match(dialogHtml, /<input type="password" id="mcpAuthTokenInput"/, '渲染结果里不是 password 输入');
  assert.doesNotMatch(dialogHtml, /id="mcpAuthTokenInput"[^>]*type="text"/, '渲染结果里出现明文输入');
  assert.match(dialogHtml, /D&amp;B Access Token/, '标题/字段名未用后端 label（应做 HTML 转义）');
  assert.equal(h.elements['#mcpAuthTitle']._text, 'D&B Access Token', '弹窗标题应直接用后端 label');
  assert.match(dialogHtml, /href="https:\/\/example\.com\/token" target="_blank" rel="noopener noreferrer"/,
    'helpUrl 未渲染成可点击外链');
  assert.match(dialogHtml, /仅存储在本机，不会上传云端/, '本地存储承诺未展示');
  assert.match(dialogHtml, /保存并连接/, '缺「保存并连接」按钮文案');

  // 模拟输入并提交：只应打到 /auth/token，且请求体含 name + token
  h.elements['#mcpAuthTokenInput'].val('SECRET-TOKEN');
  const before = h.ajaxCalls.length;
  (h.jq('#mcpAuthSaveBtn').trigger('click'), await new Promise(r => setImmediate(r)));
  const calls = h.ajaxCalls.slice(before);
  const tokenCall = calls.find(c => /\/auth\/token/.test(c.url));
  assert.ok(tokenCall, '提交未打到 /auth/token');
  assert.equal(JSON.parse(tokenCall.data).token, 'SECRET-TOKEN');
  assert.equal(JSON.parse(tokenCall.data).name, 'dnb');
  assert.ok(!calls.some(c => /servers\/add|servers\/update/.test(c.url)),
    'token 提交不得顺带写进 MCP 配置保存接口');
  assert.equal(h.elements['#mcpAuthTokenInput'].val(), '', '成功后明文输入未清空');
});

test('⑪ 运行时：oauth 分支 window.open 授权 URL，并安排 status 轮询', async () => {
  let phase = 'waiting_for_browser';
  const h = loadAuthModule(opts => {
    if (/\/auth\/state/.test(opts.url)) return {
      ok: true, name: 'oauth-svc', authType: 'oauth', connected: false, needsAuth: true,
      hasCredential: false, label: 'OAuth', helpUrl: '', helpText: '', phase: 'idle', error: null,
    };
    if (/\/auth\/start/.test(opts.url)) return {
      ok: true, phase: 'waiting_for_browser', authorizationUrl: 'https://auth.example.com/authorize?x=1',
    };
    if (/\/auth\/status/.test(opts.url)) return { ok: true, phase: phase, name: 'oauth-svc' };
    if (/\/auth\/cancel/.test(opts.url)) return { ok: true };
    return { ok: true };
  });
  const proceed = await h.McpAuth.openDialog('oauth-svc', () => {});
  assert.equal(proceed, false, 'oauth needsAuth 时必须由等待弹窗接管');
  assert.equal(h.opened.length, 1, '必须恰好打开一次系统浏览器');
  assert.equal(h.opened[0].url, 'https://auth.example.com/authorize?x=1', '打开的必须是后端返回的 authorizationUrl');
  assert.equal(h.opened[0].target, '_blank');
  assert.match(h.opened[0].features, /noopener,noreferrer/);
  assert.ok(h.timers.some(t => t.ms === 1500), '未安排 1.5s 的 /auth/status 轮询');
  const dialogHtml = (h.appended.find(a => a.sel === 'body') || {}).html || '';
  assert.match(dialogHtml, /正在等待授权/, '缺「等待授权」文案');
  assert.match(dialogHtml, /id="mcpAuthCancelBtn"/, '缺取消按钮');
  assert.match(dialogHtml, /id="mcpAuthRetryBtn"[^>]*style="display:none"/, '重试按钮应初始隐藏（失败后才显示）');

  // 取消按钮必须真的调 /auth/cancel
  const before = h.ajaxCalls.length;
  h.jq('#mcpAuthCancelBtn').trigger('click');
  await new Promise(r => setImmediate(r));
  assert.ok(h.ajaxCalls.slice(before).some(c => /\/auth\/cancel$/.test(c.url)), '取消未调 /auth/cancel');
});

test('⑫ 运行时：authType=none 时 openDialog 立即放行且不弹任何框', async () => {
  const h = loadAuthModule(() => ({ ok: true, authType: 'none', needsAuth: false, connected: false }));
  const proceed = await h.McpAuth.openDialog('plain', () => {});
  assert.equal(proceed, true, 'none 必须直接放行原有保存/安装流程');
  assert.equal(h.appended.length, 0, 'none 不得弹出任何模态框');
  assert.equal(h.opened.length, 0, 'none 不得打开浏览器');
});
