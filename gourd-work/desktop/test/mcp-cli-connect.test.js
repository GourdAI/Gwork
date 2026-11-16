/* ===== P0.5 CLI 连接器（扫码连接 + Node 自动安装）行为级契约 =====
 *
 * 仿 mcp-market-contract.test.js ㉕㉖㉗ 的写法：vm 沙箱加载**真实模块源码**，
 * 配最小 DOM stub + 可控 fetch + 虚拟时钟，实际驱动连接流程状态机，钉行为：
 *   ㉘ cli 卡片徽标「扫码连接」/ 已连接态；MCP 卡片不受影响
 *   ㉙ cli 详情：技能清单 + package@version + 无 env 表单；已连接 → 断开入口
 *   ㉚ 连接流程状态机：install → node 进度 → npm → skills → done →
 *      auth/start(qrPng) → status pending → granted（成功刷新、不发 cancel）
 *   ㉛ per-id 在途防重：连点只发一次 install；关闭后锁释放
 *   ㉜ failed → 错误 + 重试按钮 → 重试重新 install；expired → 重试重新 auth
 *   ㉝ Escape / 点遮罩关闭 = auth/cancel；安装阶段关闭不发 cancel
 *   ㉞ authorizationUrl 走 window.QRCode 本地绘制（与 McpAuth 同一管线）；
 *      waiting_url 换码重渲染；外链仅 http(s) + _blank noopener
 *
 * 虚拟时钟：模块轮询用 setTimeout(1000/2000)，测试用 advance(ms) 精确推进，
 * 不依赖真实等待（全量测试保持秒级）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..', '..', '..');
const UI = path.join(REPO, 'gourd-work', 'desktop', 'ui');
const ST = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const read = p => fs.readFileSync(p, 'utf8');
const VARIANTS = [{ tag: 'desktop', base: UI }, { tag: 'static', base: ST }];

const CLI_ID = 'official:wecom';
const MCP_ID = '@a/b';
const QR_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/* ── 最小 DOM stub：innerHTML 赋值时解析 id 注册子节点（⑬ 同口径），
 *    createElement/appendChild/removeChild 支持连接流程弹窗的动态节点。 ── */
function makeDom(opts) {
  opts = opts || {};
  const els = {};
  function mkEl(id) {
    const el = {
      id: id || '', _ls: {}, _html: '', children: [], parentNode: null,
      style: {}, attrs: {}, textContent: '', value: '', disabled: false,
      classList: { toggle() {}, contains() { return false; } },
      addEventListener(t, f) { (this._ls[t] = this._ls[t] || []).push(f); },
      listenerCount(t) { return (this._ls[t] || []).length; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      querySelectorAll(sel) {
        /* 安装在途锁探针：setInstalling(id,on) 用属性选择器查卡片 + 按钮列表并
         * toggle .installing/disabled。把命中的 DOM 记录下来供断言读取。 */
        if (typeof sel === 'string' && sel.startsWith('.mcp-market-card-add[data-id=')) {
          const b = mkEl('');
          this._installProbes = this._installProbes || [];
          this._installProbes.push(b);
          b.classList = { toggle(c, on) { b._installing = !!on; }, contains() { return !!b._installing; } };
          return [b];
        }
        return [];
      },
      querySelector() { return null; },
      closest() { return null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) els[c.id] = c; return c; },
      removeChild(c) {
        this.children = this.children.filter(x => x !== c);
        c.parentNode = null;
        /* 连同其后代注册节点一起注销（弹窗关闭后 getElementById 必须返回 null） */
        for (const k of Object.keys(els)) {
          let n = els[k];
          while (n) { if (n === c) { delete els[k]; break; } n = n._owner || n.parentNode; }
        }
        return c;
      },
      set innerHTML(v) {
        this._html = v;
        const re = /id="([^"]+)"/g; let m;
        while ((m = re.exec(v))) { const n = mkEl(m[1]); n._owner = this; els[m[1]] = n; }
      },
      get innerHTML() { return this._html; },
    };
    return el;
  }
  const root = mkEl('mcpMarketRoot');
  els['mcpMarketRoot'] = root;
  els['mcpMarketDetail'] = mkEl('mcpMarketDetail');
  /* 源 tabs + 分类栏持久宿主：切源行为级用例需要真实派发点击。
   * makeEl 的 closest() 恒返回 null，这里按 selector 补一个最小实现。 */
  if (opts.sourceTabs !== false) {
    const tabs = mkEl('mcpMarketSourceTabs');
    tabs.querySelectorAll = sel => (sel === '.mcp-market-source-tab' ? (tabs._nodes || []) : []);
    const mkTab = src => {
      const b = mkEl('');
      b.attrs['data-source'] = src;
      b.closest = s => (s === '.mcp-market-source-tab' ? b : null);
      b.classList = { toggle(c, on) { b._active = !!on; }, contains() { return !!b._active; } };
      return b;
    };
    tabs._nodes = [mkTab('official'), mkTab('modelscope')];
    els['mcpMarketSourceTabs'] = tabs;
    const bar = mkEl('mcpMarketCatBar');
    bar.querySelectorAll = () => [];
    els['mcpMarketCatBar'] = bar;
  }
  const body = mkEl('body');
  const docListeners = {};
  const document = {
    body,
    getElementById: id => els[id] || null,
    querySelector: sel => (sel === '#mcpMarketRoot' ? root : null),
    createElement: () => mkEl(''),
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
  };
  return { els, root, body, document, docListeners, mkEl };
}

/* ── 虚拟时钟 ── */
function makeClock() {
  let now = 0, seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + (Number(ms) || 0), seq: id }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending() { return timers.size; },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) {
          if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
        }
        if (!next) break;
        now = next.at;
        timers.delete(next.seq);
        next.fn();
        await new Promise(r => setImmediate(r));   // 冲掉 async 回调里的微任务链
      }
      now = target;
      await new Promise(r => setImmediate(r));
    },
  };
}

const ok = data => ({ ok: true, status: 200, json: async () => ({ code: 200, data }) });
const fail = (code, desc) => ({ ok: false, status: code, json: async () => ({ code, description: desc }) });

function cliDetail(over) {
  return Object.assign({
    id: CLI_ID, kind: 'cli', name: 'WeCom', chinese_name: '企业微信',
    description: '企业微信 CLI 连接器', tier: 'cli', auth_kind: 'cli_login',
    cli_spec: {
      package: '@wecom/cli', version: '1.3.4', binName: 'wecom',
      auth: { argv: ['auth', 'login'], urlDomain: 'work.weixin.qq.com' },
      status: { argv: ['auth', 'status'] }, unauth: { argv: ['auth', 'logout'] },
    },
    skills: [{ name: 'wecom-im', dir: 'skills/wecom-im' }, { name: 'wecom-doc', dir: 'skills/wecom-doc' }],
    skills_zip: 'UEsFBQ==',
    env_schema: { properties: { SHOULD_NOT_RENDER: { description: 'x' } }, required: ['SHOULD_NOT_RENDER'] },
    readme: '# WeCom\n\n- 能力说明',
  }, over || {});
}

/* ── 沙箱装配：opts 注入 fetch 路由 / cli 状态 / QRCode 桩 ── */
function loadCliMarket(base, opts) {
  opts = opts || {};
  const dom = makeDom(opts);
  const clock = makeClock();
  const calls = [];           // {url, method, body}
  const toasts = [];
  const qrDraws = [];
  const refreshes = { skills: 0, settingsMcp: 0 };
  const confirms = [];
  const seqs = opts.seqs || {};
  const seqIdx = {};
  function nextSeq(name, fallback) {
    const arr = seqs[name];
    if (!arr) return fallback;
    const i = seqIdx[name] || 0;
    seqIdx[name] = i + 1;
    return arr[Math.min(i, arr.length - 1)];
  }
  const fetchImpl = async (url, o) => {
    const method = (o && o.method) || 'GET';
    const body = o && o.body ? JSON.parse(o.body) : null;
    calls.push({ url: String(url), method, body });
    if (opts.fetch) {
      /* 可控 fetch：可返回 Promise（慢 cancel/start 排序）、响应对象或 null（走默认路由）。
       * 挂钟推进前不 resolve 的 Promise 用来实证「start 必须等 cancel 完成」。 */
      const r = await opts.fetch(String(url), method, body, { calls, nextSeq });
      if (r) return r;
    }
    if (/cli\/install\/status/.test(url)) return ok(nextSeq('installStatus', { phase: 'done' }));
    if (/cli\/install$/.test(url)) return ok({ taskId: 't1' });
    if (/cli\/auth\/start/.test(url)) return ok(nextSeq('authStart', { qrPng: QR_PNG }));
    if (/cli\/auth\/status/.test(url)) return ok(nextSeq('authStatus', { state: 'granted' }));
    if (/cli\/auth\/cancel/.test(url)) return ok({});
    if (/cli\/uninstall/.test(url)) return ok({});
    if (/cli\/state/.test(url)) return ok(opts.cliState || { installed: false, authorized: false, nodeReady: true });
    if (/market\/detail/.test(url)) return ok(/official(?::|%3A)wecom/i.test(url) ? cliDetail(opts.detailOver) : { name: 'B', env_schema: { properties: {}, required: [] } });
    if (/market\/categories/.test(url)) return ok([{ key: '', nameZh: '全部', name: 'All' }]);
    if (/market\/install/.test(url)) return ok({ installed: ['b'] });
    if (/market\/servers/.test(url)) {
      return ok({
        total_count: 2,
        mcp_server_list: [
          { id: CLI_ID, kind: 'cli', name: 'WeCom', auth_kind: 'cli_login', tier: 'cli' },
          { id: MCP_ID, name: 'B' },
        ],
      });
    }
    return ok({});
  };
  function QRCodeStub(el, o) { qrDraws.push({ el, opts: o }); this._opts = o; }
  QRCodeStub.CorrectLevel = { M: 0 };
  const sandbox = {
    console, URL, URLSearchParams,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    document: dom.document,
    window: {
      addEventListener() {}, showToast: (m, t) => toasts.push({ m, t }), GourdI18n: null,
      QRCode: opts.noQRCode ? undefined : QRCodeStub,
      confirm: (msg) => { confirms.push(msg); return opts.confirmAnswer !== false; },
      _skills: { refresh: () => { refreshes.skills++; } },
      _settingsMcp: { load: () => { refreshes.settingsMcp++; } },
    },
    fetch: fetchImpl,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(path.join(base, 'js', 'app-mcp-market.js')), sandbox, { filename: 'app-mcp-market.js' });
  const market = sandbox.window._mcpMarket;
  market.setHost('#mcpMarketRoot');
  const flush = () => new Promise(r => setImmediate(r));
  return {
    tag: path.basename(base), sandbox, dom, clock, calls, toasts, qrDraws, refreshes, confirms, market, flush,
    count: re => calls.filter(c => re.test(c.url)).length,
    bodyHtml: () => (dom.els['mcpCliFlowBody'] ? dom.els['mcpCliFlowBody'].innerHTML : ''),
    footHtml: () => (dom.els['mcpCliFlowFoot'] ? dom.els['mcpCliFlowFoot'].innerHTML : ''),
    overlay: () => dom.els['mcpCliFlowOverlay'] || null,
    gridHtml: () => (dom.els['mcpMarketGrid'] ? dom.els['mcpMarketGrid'].innerHTML : ''),
    modalHtml: () => dom.els['mcpMarketDetail'].innerHTML,
    clickFlow(sel) {
      const ov = dom.els['mcpCliFlowOverlay'];
      if (!ov) throw new Error('flow overlay 不存在');
      const fake = { closest: s => (s === sel ? fake : null), getAttribute: () => CLI_ID };
      (ov._ls.click || []).forEach(f => f({ target: fake }));
    },
    /* 切换目录源：派发到 #mcpMarketSourceTabs 的持久委托监听 */
    switchSource(src) {
      const tabs = dom.els['mcpMarketSourceTabs'];
      if (!tabs) throw new Error('源 tabs 宿主不存在');
      const tab = tabs._nodes.find(n => n.getAttribute('data-source') === src);
      (tabs._ls.click || []).forEach(f => f({ target: tab }));
    },
    /* 安装在途锁的可观测代理：setInstalling 会给 .mcp-market-card-add 探针
     * 写入 .installing；失败态必须清掉，否则卡片「+」/详情按钮永久 disabled。 */
    installLock() {
      const probes = (dom.root._installProbes || []).concat(dom.els['mcpMarketDetail']._installProbes || []);
      return probes.length ? probes[probes.length - 1]._installing : undefined;
    },
    escape() { (dom.docListeners.keydown || []).forEach(f => f({ key: 'Escape' })); },
  };
}

/* ㉘ CLI 卡片徽标 + 已连接态；MCP 卡片零影响 */
test('㉘ kind=cli 卡片渲染「扫码连接」徽标与连接按钮；authorized 后显示「已连接」；MCP 卡片不受影响', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base);
    await h.market.load();
    await h.flush();
    const grid = h.gridHtml();
    assert.ok(grid.includes('扫码连接'), v.tag + ': cli 卡片缺「扫码连接」徽标');
    assert.ok(/data-id="official:wecom"[^>]*>[\s\S]*?mcp-market-scan-badge/.test(grid) || /mcp-market-scan-badge[\s\S]*?扫码连接/.test(grid),
      v.tag + ': cli 徽标未复用 mcp-market-scan-badge 样式');
    /* MCP 卡片不得出现 cli 徽标/文案 */
    const mcpCard = grid.split('data-id="' + MCP_ID + '"')[1] || '';
    assert.ok(!mcpCard.includes('扫码连接'), v.tag + ': MCP 卡片被混入 cli 徽标');
    assert.ok(mcpCard.includes('data-act="install"'), v.tag + ': MCP 卡片安装入口丢失');
    /* cli/state authorized=true → 徽标变「已连接」 */
    const h2 = loadCliMarket(v.base, { cliState: { installed: true, authorized: true, nodeReady: true } });
    await h2.market.load();
    await h2.clock.advance(10);   // hydrateCliStates 的 Promise.all 落定
    await h2.flush();
    assert.ok(h2.gridHtml().includes('已连接'), v.tag + ': authorized 后卡片未显示「已连接」');
  }
});

/* ㉙ CLI 详情：技能清单 + 来源许可行 + 无 env 表单；已连接 → 断开入口 */
test('㉙ cli 详情渲染技能清单与 package@version，不渲染 env 表单；已连接显示断开入口', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base);
    await h.market.showDetail(CLI_ID);
    await h.flush();
    const html = h.modalHtml();
    assert.ok(html.includes('wecom-im') && html.includes('wecom-doc'), v.tag + ': 技能清单缺失');
    assert.ok(html.includes('包含技能'), v.tag + ': 技能清单标题缺失');
    assert.ok(html.includes('@wecom/cli@1.3.4'), v.tag + ': 许可/来源行（package@version）缺失');
    assert.ok(!/data-env=/.test(html), v.tag + ': cli 详情不得渲染 env 表单');
    assert.ok(!/data-confirm/.test(html), v.tag + ': cli 详情不得走 MCP 安装确认');
    assert.ok(/data-cli-connect/.test(html), v.tag + ': cli 详情缺「连接」主按钮');
    assert.ok(html.includes('扫码连接'), v.tag + ': cli 详情缺扫码徽标');
    /* 已连接态 */
    const h2 = loadCliMarket(v.base, { cliState: { installed: true, authorized: true, nodeReady: true } });
    await h2.market.showDetail(CLI_ID);
    await h2.flush();
    const html2 = h2.modalHtml();
    assert.ok(html2.includes('已连接'), v.tag + ': 已连接态未显示');
    assert.ok(/data-cli-disconnect/.test(html2), v.tag + ': 已连接态缺「断开连接」入口');
    assert.ok(!/data-cli-connect/.test(html2), v.tag + ': 已连接态不应再显示「连接」按钮');
    /* 断开：confirm → uninstall → 状态刷新 */
    const dcBtn = { getAttribute: () => CLI_ID, closest: function (s) { return s === '[data-cli-disconnect]' ? this : null; } };
    (h2.dom.els['mcpMarketDetail']._ls.click || []).forEach(f => f({ target: dcBtn }));
    await h2.flush(); await h2.clock.advance(5); await h2.flush();
    assert.equal(h2.count(/cli\/uninstall/), 1, v.tag + ': 断开未调用 cli/uninstall');
    assert.ok(h2.confirms.length === 1, v.tag + ': 断开前应有确认');
  }
});

/* ㉚ 连接流程状态机全链路（install → node 进度 → npm → skills → done → qrPng → pending → granted） */
test('㉚ 连接流程状态机：node 进度条 → npm/skills 阶段 → qrPng 二维码 → granted 成功刷新且不发 cancel', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base, {
      seqs: {
        installStatus: [
          { phase: 'node', nodeProgress: 30 },
          { phase: 'node', nodeProgress: 80 },
          { phase: 'npm' },
          { phase: 'skills' },
          { phase: 'done' },
        ],
        authStart: [{ qrPng: QR_PNG }],
        authStatus: [{ state: 'pending' }, { state: 'granted' }],
      },
    });
    await h.market.load();
    await h.flush();
    h.market.connectCli(CLI_ID);
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 1, v.tag + ': 未触发 cli/install');
    assert.ok(h.overlay(), v.tag + ': 连接流程弹窗未创建');
    assert.ok(h.bodyHtml().includes('正在准备 Node 运行时'), v.tag + ': node 阶段文案缺失');
    assert.ok(/mcp-cli-progress/.test(h.bodyHtml()), v.tag + ': node 阶段缺进度条');

    await h.clock.advance(1000);   // 第 1 次 install/status：node 30%
    assert.ok(/width:30%/.test(h.bodyHtml()), v.tag + ': nodeProgress=30 未落到进度条');
    await h.clock.advance(1000);   // node 80%
    assert.ok(/width:80%/.test(h.bodyHtml()), v.tag + ': nodeProgress=80 未落到进度条');
    await h.clock.advance(1000);   // npm
    assert.ok(h.bodyHtml().includes('正在安装连接器组件'), v.tag + ': npm 阶段文案缺失');
    assert.ok(!/mcp-cli-progress/.test(h.bodyHtml()), v.tag + ': npm 阶段不应再画 node 进度条');
    await h.clock.advance(1000);   // skills
    assert.ok(h.bodyHtml().includes('正在安装技能'), v.tag + ': skills 阶段文案缺失');
    await h.clock.advance(1000);   // done → auth/start
    await h.flush();
    assert.equal(h.count(/cli\/auth\/start/), 1, v.tag + ': install done 后未触发 auth/start');
    const canvas = h.dom.els['mcpCliQrCanvas'];
    assert.ok(canvas && canvas.innerHTML.includes(QR_PNG), v.tag + ': qrPng 未以 img 渲染');
    assert.ok(h.bodyHtml().includes('请用企业微信扫码'), v.tag + ': urlDomain→App 映射文案缺失（work.weixin.qq.com→企业微信）');
    assert.equal(h.qrDraws.length, 0, v.tag + ': qrPng 直给时不应再走 QRCode 绘制');

    await h.clock.advance(2000);   // auth/status pending
    assert.ok(h.bodyHtml().includes('等待扫码授权'), v.tag + ': pending 态文案缺失');
    await h.clock.advance(2000);   // granted
    await h.flush();
    assert.ok(h.bodyHtml().includes('连接成功'), v.tag + ': granted 成功态缺失');
    assert.ok(h.refreshes.skills >= 1, v.tag + ': granted 后未刷新技能页');
    assert.equal(h.count(/cli\/auth\/cancel/), 0, v.tag + ': granted 成功路径不得发 cancel');
    await h.clock.advance(1200);   // 成功态自动关闭
    assert.equal(h.overlay(), null, v.tag + ': 成功态未自动关闭');
    assert.equal(h.count(/cli\/auth\/cancel/), 0, v.tag + ': 成功关闭不得发 cancel');
    /* 在途锁已释放：可再次发起 */
    h.market.connectCli(CLI_ID);
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 2, v.tag + ': 成功后在途锁未释放');
    h.escape();
    await h.flush();
  }
});

/* ㉛ per-id 在途防重：连点只发一次 install */
test('㉛ 连接流程在途防重：连点 3 次只发一次 cli/install；Escape 关闭后锁释放', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'node', nodeProgress: 10 }], authStatus: [{ state: 'pending' }] },
    });
    await h.market.load();
    await h.flush();
    h.market.connectCli(CLI_ID);
    h.market.connectCli(CLI_ID);
    h.market.connectCli(CLI_ID);
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 1, v.tag + ': 连点发出多次 install（在途锁失效）');
    /* 卡片 + 号路径同样被锁挡住 */
    await h.market.install(CLI_ID);
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 1, v.tag + ': install() 分流未遵守在途锁');
    h.escape();
    await h.flush();
    assert.equal(h.overlay(), null, v.tag + ': Escape 未关闭流程弹窗');
    h.market.connectCli(CLI_ID);
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 2, v.tag + ': 关闭后在途锁未释放');
    h.escape();
    await h.flush();
  }
});

/* ㉜ failed / expired → 错误 + 重试 */
test('㉜ install failed 显示错误与重试按钮，重试重新 install；auth expired 重试重新 start', async () => {
  for (const v of VARIANTS) {
    /* install 阶段失败（node 下载失败） */
    const h = loadCliMarket(v.base, {
      seqs: {
        installStatus: [{ phase: 'failed', error: 'disk full' }, { phase: 'done' }],
        authStart: [{ qrPng: QR_PNG }],
        authStatus: [{ state: 'pending' }],
      },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID);
    await h.flush();
    await h.clock.advance(1000);
    assert.ok(h.bodyHtml().includes('disk full'), v.tag + ': failed 未显示真实错误');
    assert.ok(h.bodyHtml().includes('Node 运行时准备失败'), v.tag + ': node 阶段失败文案缺失');
    assert.ok(/data-cli-flow-retry/.test(h.footHtml()), v.tag + ': failed 态缺重试按钮');
    h.clickFlow('[data-cli-flow-retry]');
    await h.flush();
    assert.equal(h.count(/cli\/install$/), 2, v.tag + ': 重试未重新 install');
    await h.clock.advance(1000);   // done → auth
    await h.flush();
    assert.equal(h.count(/cli\/auth\/start/), 1, v.tag + ': 重试成功后未进入授权');
    h.escape(); await h.flush();

    /* auth 阶段过期 */
    const h2 = loadCliMarket(v.base, {
      seqs: {
        installStatus: [{ phase: 'done' }],
        authStart: [{ qrPng: QR_PNG }, { qrPng: QR_PNG }],
        authStatus: [{ state: 'expired' }, { state: 'pending' }],
      },
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID);
    await h2.flush();
    await h2.clock.advance(1000);   // done → auth/start
    await h2.flush();
    await h2.clock.advance(2000);   // expired
    assert.ok(h2.bodyHtml().includes('二维码已过期'), v.tag + ': expired 文案缺失');
    assert.ok(/data-cli-flow-retry/.test(h2.footHtml()), v.tag + ': expired 态缺重试按钮');
    h2.clickFlow('[data-cli-flow-retry]');
    await h2.flush();
    assert.equal(h2.count(/cli\/auth\/cancel/), 1, v.tag + ': auth 重试前应先 cancel 旧会话');
    assert.equal(h2.count(/cli\/auth\/start/), 2, v.tag + ': expired 重试未重新 auth/start');
    h2.escape(); await h2.flush();
  }
});

/* ㉝ Escape / 遮罩关闭 = cancel（授权已开始）；安装阶段关闭不发 cancel */
test('㉝ 关闭流程弹窗：授权阶段 Escape/点遮罩发 auth/cancel；安装阶段关闭不发 cancel', async () => {
  for (const v of VARIANTS) {
    /* 授权阶段 Escape */
    const h = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ qrPng: QR_PNG }], authStatus: [{ state: 'pending' }] },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID);
    await h.flush();
    await h.clock.advance(1000); await h.flush();   // 进入授权
    h.escape();
    await h.flush();
    assert.equal(h.overlay(), null, v.tag + ': Escape 未关闭弹窗');
    assert.equal(h.count(/cli\/auth\/cancel/), 1, v.tag + ': Escape 关闭未发 auth/cancel');
    const cancelCall = h.calls.find(c => /cli\/auth\/cancel/.test(c.url));
    assert.equal(cancelCall.body.id, CLI_ID, v.tag + ': cancel 请求体 id 错误');
    assert.equal(h.clock.pending(), 0, v.tag + ': 关闭后残留轮询定时器');

    /* 点遮罩关闭 */
    const h2 = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ qrPng: QR_PNG }], authStatus: [{ state: 'pending' }] },
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID);
    await h2.flush();
    await h2.clock.advance(1000); await h2.flush();
    const ov = h2.overlay();
    (ov._ls.click || []).forEach(f => f({ target: ov }));   // 点遮罩本体
    await h2.flush();
    assert.equal(h2.overlay(), null, v.tag + ': 点遮罩未关闭弹窗');
    assert.equal(h2.count(/cli\/auth\/cancel/), 1, v.tag + ': 点遮罩关闭未发 auth/cancel');

    /* 安装阶段关闭：无 cancel 端点语义，不发请求 */
    const h3 = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'node', nodeProgress: 5 }], authStatus: [{ state: 'pending' }] },
    });
    await h3.market.load(); await h3.flush();
    h3.market.connectCli(CLI_ID);
    await h3.flush();
    h3.escape();
    await h3.flush();
    assert.equal(h3.count(/cli\/auth\/cancel/), 0, v.tag + ': 安装阶段关闭不应发 auth/cancel');
    assert.equal(h3.clock.pending(), 0, v.tag + ': 安装阶段关闭后残留定时器');
  }
});

/* ㉞ authorizationUrl → window.QRCode 本地绘制；waiting_url 换码；外链安全 */
test('㉞ authorizationUrl 走 QRCode 管线（与 McpAuth 同源）；waiting_url 换码重渲染；外链仅 http(s)', async () => {
  for (const v of VARIANTS) {
    const url1 = 'https://login.dingtalk.com/oauth2/qr?code=AAA';
    const url2 = 'https://login.dingtalk.com/oauth2/qr?code=BBB';
    const h = loadCliMarket(v.base, {
      detailOver: {
        id: 'official:dingtalk', name: 'DingTalk',
        cli_spec: { package: 'dingtalk-workspace-cli', version: '1.0.68', auth: { argv: ['auth'], urlDomain: 'login.dingtalk.com' } },
        skills: [{ name: 'dingtalk-im', dir: 'skills/dingtalk-im' }],
      },
      seqs: {
        installStatus: [{ phase: 'done' }],
        authStart: [{ authorizationUrl: url1 }],
        authStatus: [{ state: 'waiting_url', authorizationUrl: url2 }, { state: 'pending' }],
      },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli('official:dingtalk');
    await h.flush();
    await h.clock.advance(1000); await h.flush();
    assert.equal(h.qrDraws.length, 1, v.tag + ': authorizationUrl 未走 window.QRCode 本地绘制');
    assert.equal(h.qrDraws[0].opts.text, url1, v.tag + ': QRCode 绘制内容不是授权 URL');
    assert.equal(h.qrDraws[0].opts.width, 220, v.tag + ': QRCode 尺寸应与 McpAuth 管线一致（220）');
    assert.ok(h.bodyHtml().includes('请用钉钉扫码'), v.tag + ': login.dingtalk.com→钉钉 映射缺失');
    assert.ok(h.bodyHtml().includes('href="' + url1 + '"'), v.tag + ': 缺「在浏览器中打开」外链');
    assert.ok(/target="_blank" rel="noopener noreferrer"/.test(h.bodyHtml()), v.tag + ': 外链必须 _blank + noopener noreferrer');
    await h.clock.advance(2000); await h.flush();   // waiting_url → 换码
    assert.equal(h.qrDraws.length, 2, v.tag + ': waiting_url 未触发换码重渲染');
    assert.equal(h.qrDraws[1].opts.text, url2, v.tag + ': 换码后绘制内容不是新 URL');
    assert.ok(h.bodyHtml().includes('href="' + url2 + '"'), v.tag + ': 换码后外链未更新');
    h.escape(); await h.flush();

    /* QRCode 缺失时降级为纯外链，不阻断授权 */
    const h2 = loadCliMarket(v.base, {
      noQRCode: true,
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ authorizationUrl: url1 }], authStatus: [{ state: 'pending' }] },
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID);
    await h2.flush();
    await h2.clock.advance(1000); await h2.flush();
    assert.ok(h2.bodyHtml().includes('href="' + url1 + '"'), v.tag + ': QRCode 缺失时外链兜底丢失');
    h2.escape(); await h2.flush();
  }
});

/* ═══ 2026-11 codereview 双壳缺陷行为级回归（㊱~㊵）═══════════════════════════
 *
 * 全部沿用本文件的 vm + 虚拟时钟 + 可控 fetch 骨架，断言的是**运行时行为**
 * 而不是源码字符串：请求顺序、定时器计数、DOM 节点存活、安装锁状态、缓存值。
 */

/* ㊱ P1：auth 重试 cancel 必须先于 start 完成；cancel 期间关闭不再 start；
 *        auth/start 同步返回 failed/expired 必须立即落 error 态。 */
test('㊱ auth 重试竞态：cancel 未完成时不得 start_auth；代际守卫阻止已关闭流程重启', async () => {
  for (const v of VARIANTS) {
    let releaseCancel = null;
    const cancelPending = new Promise(r => { releaseCancel = r; });
    const h = loadCliMarket(v.base, {
      seqs: {
        installStatus: [{ phase: 'done' }],
        authStart: [{ qrPng: QR_PNG }, { qrPng: QR_PNG }],
        authStatus: [{ state: 'expired' }, { state: 'pending' }],
      },
      fetch: async (url) => {
        if (/cli\/auth\/cancel/.test(url)) { await cancelPending; return ok({}); }
        return null;
      },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID);
    await h.flush();
    await h.clock.advance(1000); await h.flush();      // done → auth/start
    assert.equal(h.count(/cli\/auth\/start/), 1, v.tag + ': 首轮 auth/start 未发出');
    await h.clock.advance(2000);                       // expired → error 态
    assert.ok(h.bodyHtml().includes('二维码已过期'), v.tag + ': 未进入 expired 错误态');

    h.clickFlow('[data-cli-flow-retry]');
    await h.flush();
    assert.equal(h.count(/cli\/auth\/cancel/), 1, v.tag + ': 重试未发 cancel');
    assert.equal(h.count(/cli\/auth\/start/), 1,
      v.tag + ': cancel Promise 尚未 resolve 就发了 start_auth（P1 竞态未修复）');
    releaseCancel();                                   // cancel 完成 → 才允许 start
    await h.flush(); await h.flush();
    assert.equal(h.count(/cli\/auth\/start/), 2, v.tag + ': cancel 完成后未重新 start_auth');
    const startIdx = h.calls.map((c, i) => /cli\/auth\/start/.test(c.url) ? i : -1).filter(i => i >= 0)[1];
    const cancelIdx = h.calls.map((c, i) => /cli\/auth\/cancel/.test(c.url) ? i : -1).filter(i => i >= 0).pop();
    assert.ok(cancelIdx < startIdx, v.tag + ': 第二次 start_auth 未排在 cancel 之后');
    h.escape(); await h.flush();

    /* 代际守卫：cancel 在途期间用户关闭弹窗，resolve 后不得再 start */
    let release2 = null;
    const pending2 = new Promise(r => { release2 = r; });
    const h2 = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ qrPng: QR_PNG }], authStatus: [{ state: 'expired' }] },
      fetch: async (url) => {
        if (/cli\/auth\/cancel/.test(url)) { await pending2; return ok({}); }
        return null;
      },
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID); await h2.flush();
    await h2.clock.advance(1000); await h2.flush();
    await h2.clock.advance(2000);
    h2.clickFlow('[data-cli-flow-retry]');
    await h2.flush();
    assert.equal(h2.count(/cli\/auth\/start/), 1, v.tag + '(守卫): cancel 期间提前 start');
    h2.escape();                                      // closeCliFlow：cliFlow=null, gen++
    await h2.flush();
    release2();
    await h2.flush(); await h2.flush();
    assert.equal(h2.count(/cli\/auth\/start/), 1,
      v.tag + ': cancel 期间已关闭流程，resolve 后仍发了 start_auth（代际守卫失效）');
    assert.equal(h2.overlay(), null, v.tag + ': 关闭后 overlay 不应复活');
  }
});

test('㊱b auth/start 同步返回 failed（state 或 phase）立即落 error 态，不启动轮询', async () => {
  for (const shape of [{ state: 'failed', error: '尚未安装' }, { phase: 'failed', error: '尚未安装' }]) {
    for (const v of VARIANTS) {
      const h = loadCliMarket(v.base, {
        seqs: { installStatus: [{ phase: 'done' }], authStatus: [{ state: 'pending' }] },
        fetch: async (url) => (/cli\/auth\/start/.test(url) ? ok(shape) : null),
      });
      await h.market.load(); await h.flush();
      h.market.connectCli(CLI_ID); await h.flush();
      await h.clock.advance(1000); await h.flush();
      assert.ok(h.bodyHtml().includes('尚未安装'), v.tag + ': 同步 failed 未显示真实错误');
      assert.ok(/data-cli-flow-retry/.test(h.footHtml()), v.tag + ': 同步 failed 无重试入口');
      assert.equal(h.clock.pending(), 0, v.tag + ': 同步 failed 仍在轮询（定时器残留）');
      h.escape(); await h.flush();
    }
  }
});

/* ㊲ P1：切源时关闭在途流程 —— polling 停止、overlay 移除、安装锁释放。 */
test('㊲ 切源关闭在途 CLI 流程：clock.pending()===0、overlay 移除、锁释放、新源可重新连接', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'node', nodeProgress: 10 }], authStatus: [{ state: 'pending' }] },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID); await h.flush();
    assert.equal(h.clock.pending(), 1, v.tag + ': 前提失效：连接流程未启动轮询');
    assert.ok(h.overlay(), v.tag + ': 前提失效：overlay 未创建');
    assert.equal(h.installLock(), true, v.tag + ': 前提失效：安装锁未占用');

    h.switchSource('modelscope');
    await h.flush(); await h.clock.advance(10); await h.flush();
    assert.equal(h.clock.pending(), 0, v.tag + ': 切源后旧流程仍在轮询（定时器未清）');
    assert.equal(h.overlay(), null, v.tag + ': 切源后 body 上的 overlay 未移除');
    assert.equal(h.installLock(), false, v.tag + ': 切源后安装锁未释放');
    const statusBefore = h.count(/cli\/install\/status/);
    await h.clock.advance(5000);
    assert.equal(h.count(/cli\/install\/status/), statusBefore, v.tag + ': 切源后旧流程仍发出了状态轮询');
    /* 切源后新流程不再被 cliFlow 挡住 */
    h.market.connectCli(CLI_ID); await h.flush();
    assert.equal(h.count(/cli\/install$/), 2, v.tag + ': 切源后新连接流程被旧 cliFlow 挡住');
    h.escape(); await h.flush();
  }
});

/* ㊳ P2：失败态释放安装锁（保留 cliFlow 供重试），关闭/重试不重复破坏。 */
test('㊳ 失败态释放该 id 安装锁，重试重新占用；成功/关闭路径语义不变', async () => {
  for (const v of VARIANTS) {
    const h = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'failed', error: 'disk full' }, { phase: 'done' }], authStatus: [{ state: 'pending' }] },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID); await h.flush();
    assert.equal(h.installLock(), true, v.tag + ': 起始安装锁未占用');
    await h.clock.advance(1000);
    assert.ok(h.bodyHtml().includes('disk full'), v.tag + ': 未进入失败态');
    assert.equal(h.installLock(), false, v.tag + ': 失败态未释放安装锁（按钮永久 disabled）');
    assert.ok(h.overlay(), v.tag + ': 失败态不应销毁 cliFlow/overlay（需保留重试）');
    assert.equal(h.clock.pending(), 0, v.tag + ': 失败态仍在轮询');

    h.clickFlow('[data-cli-flow-retry]');
    await h.flush();
    assert.equal(h.installLock(), true, v.tag + ': 重试后未重新占用安装锁');
    h.escape(); await h.flush();
    assert.equal(h.installLock(), false, v.tag + ': 关闭后安装锁未释放');
    assert.equal(h.overlay(), null, v.tag + ': 关闭后 overlay 未移除');
  }
});

/* ㊴ P2：畸形 qrPng + 无授权 URL → 显式 error 态；非 http(s) URL 不得绘制/外链。 */
test('㊴ 畸形二维码立即落 error 态且不轮询；javascript: URL 不得进 QRCode 或外链', async () => {
  for (const v of VARIANTS) {
    const bad = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStatus: [{ state: 'pending' }] },
      fetch: async (url) => (/cli\/auth\/start/.test(url) ? ok({ qrPng: 'not-a-data-url' }) : null),
    });
    await bad.market.load(); await bad.flush();
    bad.market.connectCli(CLI_ID); await bad.flush();
    await bad.clock.advance(1000); await bad.flush();
    assert.ok(bad.bodyHtml().includes('二维码无效'), v.tag + ': 畸形 qrPng 未显示显式错误');
    assert.ok(/data-cli-flow-retry/.test(bad.footHtml()), v.tag + ': 畸形 qrPng 错误态缺重试');
    assert.equal(bad.clock.pending(), 0, v.tag + ': 畸形 qrPng 仍在轮询（会白等到 expired）');
    assert.equal(bad.installLock(), false, v.tag + ': 畸形 qrPng 错误态未释放安装锁');
    bad.escape(); await bad.flush();

    const evil = 'javascript:alert(1)';
    const h2 = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStatus: [{ state: 'pending' }] },
      fetch: async (url) => (/cli\/auth\/start/.test(url) ? ok({ authorizationUrl: evil }) : null),
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID); await h2.flush();
    await h2.clock.advance(1000); await h2.flush();
    assert.equal(h2.qrDraws.length, 0, v.tag + ': javascript: URL 被送进 QRCode 绘制');
    assert.ok(!h2.bodyHtml().includes('href="javascript:'), v.tag + ': javascript: 外链漏出');
    assert.ok(h2.bodyHtml().includes('二维码无效'), v.tag + ': 不安全 URL 未落 error 态');
    assert.equal(h2.clock.pending(), 0, v.tag + ': 不安全 URL 仍在轮询');
    h2.escape(); await h2.flush();
  }
});

/* ㊵ P2：granted 后以权威 cli/state 覆盖缓存；查询失败清缓存（无假阳性）。 */
test('㊵ granted 后缓存以 cli/state 响应为准；state 失败/形状异常时清缓存让 hydrate 重查', async () => {
  for (const v of VARIANTS) {
    /* 权威态：authorized=false（会话 granted 但实际未落凭据）—— 不得显示已连接 */
    const h = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ qrPng: QR_PNG }], authStatus: [{ state: 'granted' }] },
      cliState: { installed: true, authorized: false, nodeReady: true },
    });
    await h.market.load(); await h.flush();
    h.market.connectCli(CLI_ID); await h.flush();
    const stateCallsBefore = h.count(/cli\/state/);
    assert.ok(stateCallsBefore >= 1, v.tag + ': granted 前 hydrate 未查 cli/state');
    await h.clock.advance(1000); await h.flush();
    await h.clock.advance(2000); await h.flush();
    assert.ok(h.bodyHtml().includes('连接成功'), v.tag + ': granted 未落成功态');
    assert.ok(h.count(/cli\/state/) > stateCallsBefore, v.tag + ': granted 后未额外查询权威 cli/state');
    assert.ok(!h.gridHtml().includes('已连接'), v.tag + ': 权威 state.authorized=false 却显示已连接（乐观写入假阳性）');
    h.escape(); await h.flush();

    /* state 查询失败：缓存必须清掉，hydrateCliStates 会重查而非沿用硬编码字面量 */
    const h2 = loadCliMarket(v.base, {
      seqs: { installStatus: [{ phase: 'done' }], authStart: [{ qrPng: QR_PNG }], authStatus: [{ state: 'granted' }] },
      fetch: async (url) => (/cli\/state/.test(url) ? fail(500, 'state down') : null),
    });
    await h2.market.load(); await h2.flush();
    h2.market.connectCli(CLI_ID); await h2.flush();
    await h2.clock.advance(1000); await h2.flush();
    await h2.clock.advance(2000); await h2.flush();
    assert.ok(h2.bodyHtml().includes('连接成功'), v.tag + ': state 查询失败不应阻断成功态');
    assert.ok(!h2.gridHtml().includes('已连接'), v.tag + ': state 失败后仍留假阳性「已连接」');
    assert.ok(h2.count(/cli\/state/) >= 2, v.tag + ': state 失败后 hydrate 未重查');
    h2.escape(); await h2.flush();
  }
});

/* ㉟ 静态接线护栏：端点齐全、二维码复用现有管线、不引入新第三方库、MCP 路径不变 */
test('㉟ CLI 接线静态护栏：7 个端点 + QRCode 复用 + 无新依赖 + MCP 安装链保留', () => {
  VARIANTS.forEach(v => {
    const s = read(path.join(v.base, 'js', 'app-mcp-market.js'));
    ['/web/settings/mcp/cli/install', '/web/settings/mcp/cli/install/status',
      '/web/settings/mcp/cli/state', '/web/settings/mcp/cli/auth/start',
      '/web/settings/mcp/cli/auth/status', '/web/settings/mcp/cli/auth/cancel',
      '/web/settings/mcp/cli/uninstall']
      .forEach(r => assert.ok(s.includes(r), v.tag + ': 缺端点 ' + r));
    /* 二维码必须复用现有 window.QRCode（qrcode.min.js）管线，不得内联新实现 */
    assert.match(s, /new window\.QRCode\(el, \{/, v.tag + ': 未复用 window.QRCode 本地绘制管线');
    assert.ok(!/qrcode-generator|qr-creator|new QRious/.test(s), v.tag + ': 不得引入新的第三方二维码库');
    /* cli 徽标复用 scan-badge 样式 */
    assert.match(s, /mcp-market-scan-badge[\s\S]{0,120}cli_badge/, v.tag + ': cli 徽标未复用 mcp-market-scan-badge');
    /* MCP 原安装链一字不动：market/install + env 收集 + auth 分流仍在 */
    assert.match(s, /async function submitInstall\(/, v.tag + ': MCP 安装链丢失');
    assert.match(s, /function collectEnv\(/, v.tag + ': MCP env 收集丢失');
    assert.match(s, /canonicalAuthKind\(it\.auth_kind\)/, v.tag + ': MCP 卡片徽标归一丢失');
    /* 在途锁与 Escape=cancel */
    assert.match(s, /if \(!id \|\| installing\[id\] \|\| cliFlow\) return/, v.tag + ': 连接流程缺 per-id 在途锁');
    assert.match(s, /if \(cliFlow\) \{ closeCliFlow\(\); return; \}/, v.tag + ': Escape 未优先关闭 CLI 流程弹窗');
    /* 「精选/已托管」不得借尸还魂 */
    assert.ok(!/featured|hosted/i.test(s.replace(/\/\*[\s\S]*?\*\//g, '')), v.tag + ': 精选/已托管概念复活');
  });
});