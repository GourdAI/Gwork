/* =============================================================================
 * app-mcp-market.js — 「连接器」页广场目录（官方仓库默认 + 魔搭扩展）
 *
 * 2026-11 用户拍板：自建官方连接器仓库（gourd-connectors，官方目录数据
 * 编译期内置于桌面内核，随发版更新）为默认源；魔搭降级为扩展 tab。
 * 「精选」「已托管」概念移除（无效：魔搭条目几乎全 stdio 手填密钥，
 * hosted 专属 URL 未实现）。手动添加 MCP 入口保留（app-skills.js #mcpAddBtn）。
 *
 * 后端：GET  /web/settings/mcp/market/servers?search=&page=&pageSize=&category=&source=
 *       GET  /web/settings/mcp/market/detail?id=
 *       GET  /web/settings/mcp/market/categories
 *       POST /web/settings/mcp/market/install  {id, env}
 *
 * source=official（默认）走内核 mcp::registry（内置 gzip 快照，无分页）；
 * source=modelscope 走魔搭上游（分页/100 条窗口钳制）。不硬编码任何 Token。
 * ========================================================================== */
(function () {
  'use strict';

  var API = {
    servers: '/web/settings/mcp/market/servers',
    detail: '/web/settings/mcp/market/detail',
    categories: '/web/settings/mcp/market/categories',
    install: '/web/settings/mcp/market/install',
    /* CLI 连接器（kind=cli，扫码连接）生命周期端点。安装=确保 Node 运行时
     * → npm 装 CLI → 落技能；授权=厂商 CLI 扫码会话。凭据由厂商 CLI 自管，
     * 前端不接触任何 token（P0.5 契约第七节）。 */
    cliInstall: '/web/settings/mcp/cli/install',
    cliInstallStatus: '/web/settings/mcp/cli/install/status',
    cliState: '/web/settings/mcp/cli/state',
    cliAuthStart: '/web/settings/mcp/cli/auth/start',
    cliAuthStatus: '/web/settings/mcp/cli/auth/status',
    cliAuthCancel: '/web/settings/mcp/cli/auth/cancel',
    cliUninstall: '/web/settings/mcp/cli/uninstall',
  };

  /** 卡片 `+` 号安装按钮的图标。与技能卡 .skill-card-add 的 SVG **逐字节一致**
   *  （skills.css:196 / app-skills.js syncInstalledBadges），保证同页两种卡片的
   *  安装入口视觉同源；改这里必须同步改那边，否则形态又开始割裂。 */
  var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  var state = {
    root: null,
    search: '',
    category: '',
    /* 目录源：official=官方仓库（默认，内核 registry 内置 gzip 快照）；
     * modelscope=魔搭扩展（上游分页）。切换即重置分页/分类并重查。 */
    source: 'official',
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
    /* 无限滚动（对齐技能市场）：appendSeq 是 loadMore 的代际号——筛选条件一变
     * 就 ++loadSeq，追加响应回来发现代际不符即丢弃。「还有没有下一页」由
     * hasMorePages() 依据 items/page/pageSize 现算，不另存布尔态（防两份状态漂移）。 */
    appendSeq: 0,
    categories: [],
    /* 代际序号：每次 load() 递增。绝不能用布尔锁 `if (loading) return` ——
     * 首屏请求在飞时用户搜索/翻页/切分类会被【静默吞掉】：请求不发出、不渲染、
     * 不报错，上游慢一点就表现为「搜索失效 + 内容加载不出来」。
     * 改为允许并发请求都发出，但只有最新一代（seq === loadSeq）的结果允许写入
     * state 与 render；旧响应（含失败）一律丢弃，避免慢的旧请求覆盖新搜索结果。 */
    loadSeq: 0,
    /* 详情弹窗的代际号。与 loadSeq 同理：showDetail 是异步的，用户连点两张卡
     * 时两个请求都在飞，【慢的旧响应会把弹窗内容改回上一个服务】（2026-11
     * codereview 实测：先点 A(300ms) 再点 B(10ms)，最终弹窗显示 NAME-A）。
     * 只有最新一代允许写 innerHTML / data-current，旧响应一律丢弃。 */
    detailSeq: 0,
    detailCache: {},
    /* CLI 连接器授权态缓存（id → cli/state 的 {installed, authorized, nodeReady}）。
     * 卡片渲染只读缓存不逐卡发请求；load() 完成后批量补查并只重画卡片区。 */
    cliState: {},
    cliStateSeq: 0,
  };

  function t(key, fallback, params) {
    try {
      var v = (window.GourdI18n && window.GourdI18n.t) ? window.GourdI18n.t(key, params) : null;
      if (v && v !== key) return v;
    } catch (_) { /* 语言包未就绪时走兜底 */ }
    return fallback;
  }
  function m(key, fallback, params) {
    return t('settings.mcp.market.' + key, fallback, params);
  }

  /** 带 {占位符} 的错误文案。GourdI18n.t 支持第二参 params（app-i18n.js
   *  formatMessage：对象分支按 `{k}` 字面量切分替换，不拼正则）。
   *  i18n 未就绪 / 键缺失时回落 fallback，并把 {msg} 就地替换成真实错误，
   *  绝不让占位符字面量漏到界面上。 */
  function tMsg(key, fallback, msg) {
    try {
      var v = (window.GourdI18n && window.GourdI18n.t)
        ? window.GourdI18n.t('settings.mcp.market.' + key, { msg: msg }) : null;
      if (v && v.indexOf('settings.mcp.market.') !== 0 && v.indexOf('{msg}') < 0) return v;
    } catch (_) { /* 语言包未就绪走兜底 */ }
    return String(fallback).replace('{msg}', String(msg == null ? '' : msg));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, type) {
    if (window.showToast) window.showToast(msg, type || 'info');
    else console.log('[mcp-market] ' + msg);
  }
  function shortNum(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function isZh() {
    return !!(window.GourdI18n && window.GourdI18n.getLocale &&
      /^zh/i.test(window.GourdI18n.getLocale() || ''));
  }
  // 上游 locales.zh / locales.en 优先级最高，中文界面优先中文。
  function pickText(item, field) {
    var loc = item && item.locales;
    if (loc) {
      var pick = isZh() ? (loc.zh || loc['zh-CN'] || loc.en) : (loc.en || loc.zh || loc['zh-CN']);
      if (pick && pick[field]) return pick[field];
    }
    if (!item) return '';
    return item['chinese_name'] && field === 'name' ? item['chinese_name'] : (item[field] || '');
  }

  /** readme 本地化选取：实测上游中文正文在 locales.zh.readme、英文在 locales.en.readme，
   *  顶层 readme 也有内容但不含语言选择。中文界面优先中文正文，缺省回退顶层。 */
  function pickReadme(d) {
    var loc = d && d.locales;
    if (loc) {
      var primary = isZh() ? (loc.zh || loc['zh-CN'] || loc.en) : (loc.en || loc.zh || loc['zh-CN']);
      if (primary && primary.readme) return String(primary.readme);
    }
    return String((d && d.readme) || '');
  }

  /**
   * 上游 readme 是 Markdown 原文，实测混有大量 HTML table（<table>/<col>/<span>）
   * 且近 5 万字符。旧版整段塞进 <pre> 且 slice(1200)，既显示一堆标签源码、
   * 又截出半截标签 —— 用户报「详情页面显示有问题」。
   *
   * 安全策略：先把 HTML 标签整体剥离（在 esc 之前），再对纯文本逐行做**轻量**
   * Markdown 渲染。所有文本都过 esc()，链接 URL 只放行 http(s)（防 javascript: 注入），
   * 图片行跳过（避免一堆外链/base64）。不做完整 Markdown，够用且无 XSS 面。
   */
  function renderReadme(raw) {
    var text = String(raw || '')
      .replace(/<[^>]*>/g, '')                 // 剥离上游 HTML 标签（表格等）
      .replace(/&nbsp;/gi, ' ')
      .replace(/\u00a0/g, ' ')                 // U+00A0 不换行空格 → 普通空格
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\r\n/g, '\n');
    var lines = text.split('\n');
    var out = [];
    /* 当前打开的列表标签名（'ul' | 'ol' | null）。有序/无序必须分开闭合：
     * 若只用一个 inList 布尔，`- a` 后紧跟 `1. b` 会把 <li> 塞进同一个 <ul>，
     * 有序步骤丢掉编号语义。切换到另一种列表时先闭合旧的再开新的。 */
    var listTag = null;
    function closeList() { if (listTag) { out.push('</' + listTag + '>'); listTag = null; } }
    function openList(tag) {
      if (listTag === tag) return;
      closeList();
      out.push('<' + tag + '>');
      listTag = tag;
    }
    function inline(s) {
      var h = esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // 链接：仅放行 http(s)，其余原样显示文本，杜绝 javascript:/data: 注入
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return h;
    }
    lines.forEach(function (line) {
      var ln = line.trim();
      if (!ln) { closeList(); return; }
      if (/^!\[.*\]\(.*\)$/.test(ln)) return;             // 图片行跳过
      var h = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); return; }
      /* 有序列表 `1. xxx` / `1) xxx`。2026-11 codereview P2-3：此前不支持，
       * `1. first` 被渲染成 <p>1. first</p>（编号变正文、CSS 的 ol 规则永不可达）。
       * readme 里的安装步骤几乎都是有序列表，这是常态而非边角。 */
      var oli = /^\d{1,9}[.)]\s+(.*)$/.exec(ln);
      if (oli) { openList('ol'); out.push('<li>' + inline(oli[1]) + '</li>'); return; }
      var li = /^[-+*]\s+(.*)$/.exec(ln);
      if (li) { openList('ul'); out.push('<li>' + inline(li[1]) + '</li>'); return; }
      closeList();
      out.push('<p>' + inline(ln) + '</p>');
    });
    closeList();
    return out.join('');
  }

  async function api(url, opts) {
    var res = await fetch(url, opts);
    var json = await res.json();
    if (!res.ok || (json && json.code && json.code !== 200)) {
      throw new Error((json && (json.description || json.message)) || ('HTTP ' + res.status));
    }
    return json && json.data !== undefined ? json.data : json;
  }

  function query() {
    var p = new URLSearchParams();
    if (state.search) p.set('search', state.search);
    p.set('page', String(state.page));
    p.set('pageSize', String(state.pageSize));
    if (state.category) p.set('category', state.category);
    p.set('source', state.source);
    return p.toString();
  }

  // ─── 渲染 ────────────────────────────────────────────────────────────────
  function shell() {
    /* 分类 chip 与技能分类栏**同一类名**（.skills-category-chip）：用户拍板
     * 「分类切换的样式按照技能的统一」。旧 .skills-category-chip 是描边胶囊 +
     * accent 实底 active，与技能的「无描边 + bg-hover active」割裂。 */
    var cats = state.categories.map(function (c) {
      var name = (window.GourdI18n && /zh/i.test(window.GourdI18n.getLocale ? window.GourdI18n.getLocale() : '')) ? c.nameZh : (c.name || c.nameZh);
      return '<button type="button" class="skills-category-chip' + (state.category === c.key ? ' active' : '') +
        '" data-cat="' + esc(c.key) + '">' + esc(name || c.nameZh) + '</button>';
    }).join('');
    /* 排版对齐技能市场：壳内不再画标题/搜索/分页三件套。
     * 搜索唯一真源 = 顶栏 #skillsSearchInput（app-skills.js 分派）；
     * 分类 chips 上提到头部固定的 #mcpMarketCatBar（与技能分类栏同一位置、
     * 同一 hscroll 机制），宿主缺失时原地回退，独立嵌入仍可用；
     * 目录源 tabs（官方/魔搭扩展）在头部筛选行；列表无限滚动，
     * 底部 #mcpMarketSentinel 交给 IntersectionObserver 触发 loadMore。 */
    var catsBar = document.getElementById('mcpMarketCatBar');
    if (catsBar) catsBar.innerHTML = cats;
    syncSourceTabs();
    var totalEl = document.getElementById('mcpMarketTotal');
    if (totalEl) totalEl.textContent = state.total ? String(state.total) : '';
    return '' +
      '<div class="mcp-market">' +
      (catsBar ? '' : '  <div class="mcp-market-cats">' + cats + '</div>') +
      '  <div id="mcpMarketGrid" class="mcp-market-grid"></div>' +
      '  <div id="mcpMarketSentinel" class="mcp-market-sentinel"></div>' +
      '</div>';
    /* ⚠ 详情弹窗 #mcpMarketDetail 是 skills.html 里的【持久节点】（.skills-view 直接
     * 子元素、滚动区外），绝不能在这里生成：
     *   ① 生成在 root.innerHTML 内会被每次 render()（翻页/搜索/切分类/语言切换）
     *      整个冲掉 —— 用户「详情页面显示有问题」的直接根因；
     *   ② 会与持久节点形成双 ID；③ 在 overflow-y:auto 的滚动区内 position:fixed
     *      有被裁剪/定位错乱风险。这里只渲染目录，弹窗由 openDetail 单独填充。 */
  }

  /** 分类 key → 当前语言名。列表项的 categories 是真实返回的数组。 */
  function catName(key) {
    var zh = !!(window.GourdI18n && /zh/i.test(window.GourdI18n.getLocale ? window.GourdI18n.getLocale() : ''));
    var c = null;
    for (var i = 0; i < state.categories.length; i++) {
      if (state.categories[i].key === key) { c = state.categories[i]; break; }
    }
    if (!c) return key || '';
    return (zh ? (c.nameZh || c.name) : (c.name || c.nameZh)) || key;
  }

  /** 从详情的 server_config 读第一个 auth 声明的 authType（仅展示用，非密钥）。
   * 兼容扁平 `authType`（后端 normalize 明确支持该形态，只读嵌套会出现
   * 「卡片有徽标、详情无徽标」的不一致）。 */
  function detailAuthKind(d) {
    try {
      var sc = d && d.server_config;
      var servers = sc && sc[0] && sc[0].mcpServers;
      if (!servers) return '';
      for (var k in servers) {
        if (!Object.prototype.hasOwnProperty.call(servers, k)) continue;
        var cfg = servers[k] || {};
        var a = cfg.auth;
        if (a && a.authType) return String(a.authType);
        if (cfg.authType) return String(cfg.authType);
      }
    } catch (_) { /* 形状异常时不画徽标 */ }
    return '';
  }

  /** 后端 AuthKind::parse 的别名表（auth.rs）：目录条目若带别名拼写，
   * 后端按规范形态处理，卡片徽标必须同口径，否则「后端要授权、卡片无徽标」。 */
  function canonicalAuthKind(k) {
    k = String(k || '').trim().toLowerCase();
    if (k === 'qrcode_poll' || k === 'qrcode' || k === 'qr_poll' || k === 'scan') return 'qrcode_poll';
    if (k === 'oauth' || k === 'oauth2' || k === 'browser' || k === 'login') return 'oauth';
    if (k === 'token' || k === 'static' || k === 'apikey' || k === 'api_key') return 'token';
    return k;
  }

  /** CLI 连接器判定（P0.5 契约）：官方列表 item 新增 kind:"cli"；
   *  MCP 条目无 kind 字段或 kind:"mcp"，行为一字不动。 */
  function isCliItem(it) {
    return !!(it && it.kind === 'cli');
  }

  /** cli/state 的 authorized=true 才算「已连接」（installed 只是 npm 包就绪，
   *  未扫码授权的连接器不能显示已连接）。缓存缺失时按未连接渲染。 */
  function cliAuthorized(id) {
    var st = state.cliState[id];
    return !!(st && st.authorized);
  }

  function cards() {
    var grid = document.getElementById('mcpMarketGrid');
    if (!grid) return;
    if (!state.items.length) {
      grid.innerHTML = '<div class="mcp-market-empty">' + esc(m('empty', '未找到 MCP 服务')) + '</div>';
      return;
    }
    grid.innerHTML = state.items.map(function (it) {
      var id = esc(it.id || '');
      var logo = it.logo_url
        ? '<img class="mcp-market-logo" src="' + esc(it.logo_url) + '" alt="" loading="lazy">'
        : '<div class="mcp-market-logo mcp-market-logo-ph">M</div>';
      /* 列表接口（PUT /mcp/servers）实测只返回：
       *   id, publisher, name, chinese_name, description, tags, logo_url,
       *   view_count, locales, categories, auth_kind(官方源)
       * **不含** is_hosted / is_verified —— 那两个字段只在详情接口里有。
       * 所以卡片不画认证 badge（否则永远不显示，是死代码），改画真实存在的
       * categories + 授权形态徽标；is_verified 在详情弹窗显示。 */
      var meta = [];
      if (Array.isArray(it.categories) && it.categories.length) meta.push(esc(catName(it.categories[0])));
      if (it.view_count != null) meta.push(esc(shortNum(it.view_count)));
      /* 授权形态徽标（官方目录实测分级）：oauth=登录/扫码授权（DCR 实测开放，
       * 点连接弹标准 OAuth 浏览器登录）；qrcode_poll=扫码（腾讯文档真扫码）；
       * token=静态 Token。魔搭扩展条目无 auth 声明则不画——不再画「精选」。
       * CLI 连接器（kind=cli）：徽标「扫码连接」（复用 scan-badge 样式）；
       * 已授权（cli/state.authorized）改显「已连接」。MCP 条目路径一字不动。 */
      var badges = '';
      var ak = canonicalAuthKind(it.auth_kind);
      if (isCliItem(it)) {
        badges += '<span class="mcp-market-badge mcp-market-scan-badge">' +
          esc(cliAuthorized(it.id) ? m('cli_connected', '已连接') : m('cli_badge', '扫码连接')) + '</span>';
      } else if (ak === 'qrcode_poll') {
        badges += '<span class="mcp-market-badge mcp-market-badge-scan">' + esc(m('scan_badge', '扫码授权')) + '</span>';
      } else if (ak === 'oauth') {
        badges += '<span class="mcp-market-badge mcp-market-badge-oauth">' + esc(m('oauth_badge', '登录/扫码授权')) + '</span>';
      } else if (ak === 'token') {
        badges += '<span class="mcp-market-badge mcp-market-badge-token">' + esc(m('token_badge', 'Token')) + '</span>';
      }
      /* 卡片安装入口与技能卡**同形态**（用户拍板：「和技能安装样式保持一致」）。
       * 技能卡是右上角一个 26px 的 `+` 号图标按钮（.skill-card-add，skills.css:196），
       * 不是文字按钮；此前 MCP 卡放了「详情 / 连接」两个文字按钮，与同页技能卡
       * 形态割裂，且「详情」与「点整卡」语义重复（整卡可点开弹窗）。
       * 现统一为：整卡可点开连接弹窗 + 右上角 `+` 号一键连接（语义等同技能安装）。
       * 图标 SVG 与 skills 的 .skill-card-add 完全一致（同 24 viewBox、同 stroke）。
       *
       * `+` 按钮走 install(id)（无 env）：有必填 env 时 install 会自动转弹窗补填，
       * 不会把空值直接提交给后端。 */
      /* CLI 卡片 `+` 号语义 = 「连接」（cli_connect），已连接时提示「已连接」；
       * MCP 卡片文案与行为保持原样。 */
      var addLabel = isCliItem(it)
        ? (cliAuthorized(it.id) ? m('cli_connected', '已连接') : m('cli_connect', '连接'))
        : m('connect', '连接');
      return '' +
        '<div class="mcp-market-card" data-id="' + id + '">' +
        '  <div class="mcp-market-card-top">' + logo +
        '    <div class="mcp-market-card-name">' + esc(pickText(it, 'name') || it.id) + '</div>' +
        '    <button type="button" class="mcp-market-card-add" data-act="install" data-id="' + id +
        '" title="' + esc(addLabel) + '" aria-label="' + esc(addLabel) + '">' + PLUS_SVG + '</button>' +
        '  </div>' +
        '  <div class="mcp-market-card-desc">' + esc(pickText(it, 'description')) + '</div>' +
        '  <div class="mcp-market-card-foot">' +
        '    <span class="mcp-market-meta">' + meta.join(' · ') + '</span>' + badges +
        '  </div>' +
        '</div>';
    }).join('');
  }

  /** 上游 100 条窗口钳制：page*pageSize>=100 或本页不满即无下一页。
   *  官方源一次性返回全部（无分页），永远没有下一页。 */
  function hasMorePages() {
    if (state.source !== 'modelscope') return false;
    return state.items.length > 0 &&
      state.items.length >= state.page * state.pageSize &&
      state.page * state.pageSize < 100;
  }

  function syncChrome() {
    if (!state.root) return;
    var totalEl = document.getElementById('mcpMarketTotal');
    if (totalEl) totalEl.textContent = state.total ? String(state.total) : '';
    syncSourceTabs();
    var sentinel = document.getElementById('mcpMarketSentinel');
    if (sentinel) {
      var st = state.appending ? 'loading'
        : (state.loadError ? 'error' : (!hasMorePages() && state.items.length ? 'end' : ''));
      sentinel.className = 'mcp-market-sentinel' + (st ? ' ' + st : '');
      sentinel.textContent = st === 'loading' ? t('settings.skills.loading', '加载中…')
        : st === 'error' ? t('settings.skills.load_failed_retry', '加载失败，点击重试')
        : st === 'end' ? t('settings.skills.no_more', '没有更多了') : '';
    }
    var bars = [state.root, document.getElementById('mcpMarketCatBar')];
    bars.forEach(function (bar) {
      if (!bar || !bar.querySelectorAll) return;
      /* 分类 chip 与技能分类栏同类名（.skills-category-chip），样式统一。 */
      bar.querySelectorAll('.skills-category-chip').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-cat') === state.category);
      });
    });
  }

  /** 源 tabs active 态同步（官方/魔搭扩展）。 */
  function syncSourceTabs() {
    var tabs = document.getElementById('mcpMarketSourceTabs');
    if (!tabs) return;
    tabs.querySelectorAll('.mcp-market-source-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-source') === state.source);
    });
  }

  function render() {
    if (!state.root) return;
    /* 搜索框已迁到持久顶栏（#skillsSearchInput），render() 不再销毁输入框，
     * 「重建后恢复焦点/光标」的补偿逻辑随之退役——结构性消灭，而非继续打补丁。
     * 分类 chips 同理迁到头部持久宿主 #mcpMarketCatBar（shell 内回填）。 */
    state.root.innerHTML = shell();
    cards();
    syncChrome();
    bind();
    observeSentinel();
  }

  /**
   * 挂在宿主 root 上的**委托监听器只能绑一次**。
   *
   * root（#mcpMarketRoot）是 skills.html 里的持久节点，render() 只换它的 innerHTML；
   * innerHTML 替换不会移除 root 自身的监听器。若 bind() 每次 render 都 addEventListener，
   * 第 N 次 load() 后一次点击会命中 N 个监听器：install() 被调用 N 次，
   * 而 mcp_server_add 对重名直接返回 400，用户会看到「已安装」紧跟着
   * 「安装失败：Server name already exists」。
   *
   * 因此委托绑定用 boundRoot 记忆化；search/chip/pager 等**随 innerHTML 重建的节点**
   * 仍然每次重新绑定（旧节点连同旧监听器一起被丢弃，不会泄漏）。
   */
  var boundRoot = null;
  var boundModal = null;

  function bindDelegationOnce(root) {
    if (boundRoot === root) return;
    boundRoot = root;
    root.addEventListener('click', function (e) {
      /* 分类 chip / 底部哨兵与卡片同用一个委托（innerHTML 重建不丢监听）。
       * chips 正常在头部宿主，这里是宿主缺失时的原地回退路径。 */
      var chip = e.target.closest ? e.target.closest('.skills-category-chip') : null;
      if (chip) { setCategory(chip.getAttribute('data-cat') || ''); return; }
      var sentinel = e.target.closest ? e.target.closest('#mcpMarketSentinel') : null;
      if (sentinel) { if (state.loadError) { state.loadError = false; loadMore(); } return; }
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      if (btn) {
        var id = btn.getAttribute('data-id');
        if (btn.getAttribute('data-act') === 'detail') showDetail(id);
        else if (btn.getAttribute('data-act') === 'install') install(id);
        return;
      }
      /* 整卡可点：与 WorkBuddy 一致，点卡片任意空白处打开「连接」弹窗。
       * 按钮已在上面 return，不会走到这里（不会误触发二次动作）。 */
      var card = e.target.closest ? e.target.closest('.mcp-market-card') : null;
      if (card) showDetail(card.getAttribute('data-id'));
    });
  }

  /** 弹窗同样是持久节点（skills.html），委托监听也只绑一次，避免 render() 反复累积。 */
  function bindModalOnce() {
    var modal = document.getElementById('mcpMarketDetail');
    if (!modal || boundModal === modal) return;
    boundModal = modal;
    modal.addEventListener('click', function (e) {
      if (e.target === modal || (e.target.closest && e.target.closest('[data-close]'))) closeDetail();
      /* CLI 详情专属动作（data-cli-connect / data-cli-disconnect）与 MCP 的
       * data-confirm/data-retry 分离，MCP 条目行为一字不动。 */
      var cliBtn = e.target.closest ? e.target.closest('[data-cli-connect]') : null;
      if (cliBtn) { startCliFlow(cliBtn.getAttribute('data-id')); return; }
      var dcBtn = e.target.closest ? e.target.closest('[data-cli-disconnect]') : null;
      if (dcBtn) { cliDisconnect(dcBtn.getAttribute('data-id')); return; }
      if (e.target.closest && e.target.closest('[data-confirm]')) confirmInstall();
      /* 错误态的「重试」：清掉可能已污染的缓存条目后重新拉详情。
       * 必须走 showDetail 而不是直接 api()：它带代际守卫，重试期间用户点了
       * 别的卡片也不会被这次慢响应盖掉。 */
      var retryBtn = e.target.closest ? e.target.closest('[data-retry]') : null;
      if (retryBtn) {
        var rid = retryBtn.getAttribute('data-id');
        delete state.detailCache[rid];
        showDetail(rid);
      }
    });
  }

  function bind() {
    var root = state.root;
    if (!root) return;
    bindDelegationOnce(root);
    /* 弹窗 #mcpMarketDetail 是 skills.html 的持久节点，不再随 render() 重建，
     * 因此委托监听只绑一次（旧版每次 render addEventListener 会累积 N 个监听器）。 */
    bindModalOnce();
    bindHeadOnce();
  }

  /** 筛选统一入口：条件变化 → 重置到第一页重查（代际号自增，在途追加作废）。 */
  function setCategory(cat) {
    if (state.category === cat) return;
    state.category = cat;
    state.page = 1;
    load();
  }

  /* 头部筛选区是 skills.html 的持久节点，委托只绑一次（与 bindDelegationOnce 同口径）。
   * 宿主不在（独立嵌入/测试沙箱）时静默跳过。
   * 2026-11：「精选/已托管」勾选退役，换成目录源 tabs（官方/魔搭扩展）。 */
  var boundHead = false;
  function bindHeadOnce() {
    if (boundHead) return;
    var bar = document.getElementById('mcpMarketCatBar');
    var tabs = document.getElementById('mcpMarketSourceTabs');
    if (!bar && !tabs) return;
    boundHead = true;
    if (bar) bar.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.skills-category-chip') : null;
      if (chip) setCategory(chip.getAttribute('data-cat') || '');
    });
    if (tabs) tabs.addEventListener('click', function (e) {
      var tab = e.target.closest ? e.target.closest('.mcp-market-source-tab') : null;
      if (!tab) return;
      var src = tab.getAttribute('data-source') || 'official';
      if (src === state.source) return;
      /* P1：切源先关闭在途 CLI 连接流程。#mcpCliFlowOverlay 挂在 body 上，
       * 不随 render() 销毁 —— 旧流程会继续轮询，且 cliFlow/installing 锁会挡住
       * 新源上发起的连接。放在实际切换逻辑最前面：先失效代际/清定时器/释放锁，
       * 再动 state.source 与后续 load()。 */
      closeCliFlow();
      state.source = src;
      state.page = 1;
      /* 分类必须随源重置：两源分类覆盖不同（如 version-control 在官方目录
       * 0 条），携带旧分类切源会掉进「chip 高亮但列表永远空」的陷阱。 */
      state.category = '';
      /* 滚动容器 #skillsScroll 是持久节点：长列表底部切源后视口不能停在
       * 新列表中段。 */
      var sc = document.getElementById('skillsScroll');
      if (sc) sc.scrollTop = 0;
      /* tab active 态立即切换 + 分类 chips 立即重画（不等响应）：慢网下
       * 点击无反馈会诱发重复点击。分类表随源重取（在途守卫防过期覆盖）。 */
      syncSourceTabs();
      syncChrome();
      loadCategories().then(function () { syncChrome(); });
      load();
    });
  }

  /* ── 无限滚动 ──────────────────────────────────────────────────────────
   * 滚动容器是外层 #skillsScroll（技能页共用）。IntersectionObserver 盯
   * 底部哨兵，提前 200px 预取；宿主缺失时退回 scroll 监听。两者都只触发
   * loadMore()，由 appendSeq/loadSeq 双代际守卫兜并发。 */
  var sentinelIO = null;
  var boundScrollEl = null;
  function observeSentinel() {
    var sentinel = document.getElementById('mcpMarketSentinel');
    if (!sentinel) return;
    if (typeof IntersectionObserver === 'function') {
      if (sentinelIO) sentinelIO.disconnect();
      sentinelIO = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) loadMore();
      }, { rootMargin: '200px 0px' });
      sentinelIO.observe(sentinel);
      return;
    }
    var sc = document.getElementById('skillsScroll');
    if (!sc || boundScrollEl === sc || !sc.addEventListener) return;
    boundScrollEl = sc;
    sc.addEventListener('scroll', function () {
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 200) loadMore();
    }, { passive: true });
  }

  async function loadMore() {
    if (!state.root || state.appending || state.loadError) return;
    if (!hasMorePages()) return;
    /* 首屏在飞时不追加：等 load() 渲染完，哨兵仍可见会再次触发。 */
    if (!state.items.length) return;
    state.appending = true;
    syncChrome();
    var seq = state.loadSeq;            // 追加属于当前筛选代际
    var ap = ++state.appendSeq;
    var nextPage = state.page + 1;
    var p = new URLSearchParams();
    if (state.search) p.set('search', state.search);
    p.set('page', String(nextPage));
    p.set('pageSize', String(state.pageSize));
    if (state.category) p.set('category', state.category);
    p.set('source', state.source);
    try {
      var data = await api(API.servers + '?' + p.toString());
      if (seq !== state.loadSeq || ap !== state.appendSeq) return;   // 筛选已变，丢弃
      var items = (data && (data.mcp_server_list || data.servers)) || [];
      state.page = nextPage;
      state.total = Number(data && data.total_count) || state.total;
      /* 去重追加：上游翻页偶有重叠条目，重复 data-id 会让整卡点击歧义。 */
      var seen = {};
      state.items.forEach(function (it) { seen[it.id] = true; });
      items.forEach(function (it) { if (!seen[it.id]) { seen[it.id] = true; state.items.push(it); } });
    } catch (e) {
      if (seq !== state.loadSeq || ap !== state.appendSeq) return;
      state.loadError = true;
      toast(tMsg('load_failed', '连接器目录加载失败：{msg}', e.message), 'error');
    } finally {
      if (seq === state.loadSeq && ap === state.appendSeq) state.appending = false;
    }
    if (seq !== state.loadSeq || ap !== state.appendSeq) return;
    /* 追加只重画卡片区，不整壳重建：分类 chips/头部/滚动位置全部保持。 */
    cards();
    syncChrome();
  }

  // ─── 数据 ────────────────────────────────────────────────────────────────
  async function loadCategories() {
    var src = state.source;
    try {
      /* 分类表按源取：官方源只返回实际有条目的分类（后端聚合），
       * 避免官方 tab 出现「点进去永远空白」的死 chip。 */
      var data = await api(API.categories + '?source=' + encodeURIComponent(src));
      if (src !== state.source) return;   // 在途切源：过期分类表不覆盖新源
      state.categories = Array.isArray(data) ? data : (data.categories || []);
    } catch (e) {
      if (src !== state.source) return;
      console.warn('[mcp-market] categories failed: ' + e.message);
      state.categories = [{ key: '', nameZh: '全部', name: 'All' }];
    }
  }

  async function load() {
    if (!state.root) return;
    /* 每次调用都领一个代际号并【真正发出请求】，不吞并发。
     * switchView 里 showPane() 可能先调 search(q)，随后又调 load()；
     * 旧版布尔锁会把其中一次静默丢弃，页面停在空白且无任何提示。 */
    var seq = ++state.loadSeq;
    /* 新筛选代际：在途追加作废，加载/错误态归零。 */
    state.appending = false;
    state.loadError = false;
    state.page = 1;
    try {
      var data = await api(API.servers + '?' + query());
      // 已有更新的请求发出：丢弃这个过期响应，绝不覆盖新结果
      if (seq !== state.loadSeq) return;
      state.items = (data && (data.mcp_server_list || data.servers)) || [];
      state.total = Number(data && data.total_count) || 0;
    } catch (e) {
      if (seq !== state.loadSeq) return;   // 过期失败也不许清掉新结果 / 弹旧错误
      state.items = [];
      state.total = 0;
      toast(tMsg('load_failed', '连接器目录加载失败：{msg}', e.message), 'error');
    }
    if (seq !== state.loadSeq) return;     // render 前再确认一次，双保险
    render();
    /* CLI 授权态补查：卡片首绘用缓存（缺省未连接），列表就位后批量查
     * cli/state 并只重画卡片区，把「已连接」徽标补上。MCP-only 列表零请求。 */
    hydrateCliStates();
  }

  /** 批量补查本页 CLI 条目的 cli/state（per-id GET，失败静默按未连接）。
   *  带代际守卫：筛选已切换时旧响应不得污染新页徽标。 */
  function hydrateCliStates() {
    var ids = [];
    state.items.forEach(function (it) { if (isCliItem(it) && it.id) ids.push(it.id); });
    if (!ids.length) return;
    var seq = ++state.cliStateSeq;
    Promise.all(ids.map(function (id) {
      return api(API.cliState + '?id=' + encodeURIComponent(id))
        .then(function (st) { return { id: id, st: st }; })
        .catch(function () { return null; });
    })).then(function (rows) {
      if (seq !== state.cliStateSeq) return;
      var changed = false;
      rows.forEach(function (r) {
        if (!r || !r.st) return;
        state.cliState[r.id] = r.st;
        changed = true;
      });
      if (changed && state.root) cards();
    });
  }

  /* ⚠ 这里【刻意没有】WorkBuddy 那种「试试这样用」示例区。
   *
   * 2026-11 曾实现过一版：从 readme 的 Markdown 列表项里提炼前 3 条当示例。
   * 用户 codereview 抓出它是 P0 —— 实测喂真实 readme 进去，渲染出来的是：
   *     💡 试试这样用
   *     · 需要 Python 3.10 或更高版本才能运行本服务
   *     · uv >= 0.1.30
   *     · 本项目采用 MIT 许可证开源
   * 根因：判据只有「是列表项 + 长度 ≥12 + 不以 http 开头」，这是**格式判据冒充
   * 语义判据**。而绝大多数 MCP 的 readme 开头几个列表项恰恰就是 Requirements /
   * Prerequisites / License，所以「提炼到环境要求」是常态路径而非边角案例。
   *
   * 用户拍板：**整块砍掉**。上游魔搭详情确实没有示例字段（实测只有
   * readme / env_schema / server_config / locales），WorkBuddy 的示例卡来自其
   * 自营精选目录的人工编排数据，我们没有这个数据基础。宁可不显示，不可显示假的。
   *
   * 因此 `try_it` i18n 键已一并移除（见 ⑥ 键集契约的反向断言，防死键复活）。
   * 若日后上游提供了真正的示例字段，再按真实字段渲染并补语料护栏。 */

  /**
   * WorkBuddy 式详情弹窗：
   *   hero —— 居中大 logo +「连接 {名称}」标题 + 认证/托管徽标 + 描述 + 主「连接」按钮；
   *   body —— 对接配置表单（env_schema，仅在字段可被持久化时出现）+ readme 全文；
   *   foot —— 取消 + 保存并连接（有配置表单时）/ 取消 + 连接（无表单时）。
   * 弹窗节点本身是 skills.html 的持久节点 #mcpMarketDetail，这里只填 innerHTML。
   *
   * ⚠ 代际守卫：本函数是异步的，用户连点两张卡时两个请求都在飞。没有守卫时
   * 【慢的旧响应会把弹窗内容改回上一个服务】（2026-11 codereview 实测：先点
   * A(300ms) 再点 B(10ms)，最终弹窗显示 NAME-A、data-current=A）。与 load() 的
   * loadSeq 同口径：只有最新一代允许写 DOM，旧响应（含失败）一律丢弃。
   */
  async function showDetail(id) {
    var modal = document.getElementById('mcpMarketDetail');
    if (!modal) return;
    /* 独立深链/外部直调 showDetail 时市场可能尚未 load()：委托监听幂等补绑，
     * 否则弹窗里的连接/关闭按钮全部失灵。 */
    bindModalOnce();
    var seq = ++state.detailSeq;
    modal.style.display = 'flex';
    modal.innerHTML = '' +
      '<div class="mcp-market-modal-box mcp-market-modal-loading">' +
      '<div class="mcp-market-loading-dot"></div></div>';
    var d;
    try {
      if (state.detailCache[id]) d = state.detailCache[id];
      else { d = await api(API.detail + '?id=' + encodeURIComponent(id)); state.detailCache[id] = d; }
    } catch (e) {
      if (seq !== state.detailSeq) return;      // 过期失败不许盖掉用户正在看的新详情
      renderDetailError(modal, id, e.message);
      return;
    }
    if (seq !== state.detailSeq) return;        // 过期成功响应同样丢弃
    /* CLI 连接器走专属详情（能力描述 + 技能清单 + 连接/断开），不渲染
     * env 表单 / MCP 配置。MCP 条目继续走下方原有渲染，一字不动。 */
    if (isCliItem(d)) { await renderCliDetail(modal, id, d, seq); return; }
    var schema = (d && d.env_schema) || {};
    var props = schema.properties || {};
    var required = schema.required || [];
    /* ⚠ env 表单的可显示判据必须与后端【同源】，不能在前端复刻 http 别名表。
     *
     * 背景（2026-11 codereview 抓出的 P1）：http 家族（sse/streamable/…）在
     * build_entry 里只落 url/headers，**没有 env 字段**；后端 install 的冲突护栏
     * 又只在 `env_schema.required` 非空时才拦。于是「http 型 + 只有可选 env 项」
     * 会形成一条静默丢弃密钥的路径：前端照旧摆输入框索要值 → 后端 guard 放行 →
     * 用户填了 → normalize 的 http 分支无处可写 supplied_env → 提示安装成功、
     * 密钥丢失、服务连不上且无从排查。
     *
     * 修法：由内核在详情响应里注入 `env_supported`（Rust 走 mcp::is_http_type、
     * Java 走 McpTypeResolver.isHttpType，各自都是唯一的 http 判定真源），前端只读
     * 标志、不自己判类型。**缺字段时按 true 处理**：老内核不会注入它，
     * 此时行为与改造前一致（宁可退回旧形态，也不能让所有服务都失去 env 表单）。 */
    var envSupported = !(d && d.env_supported === false);
    var propKeys = Object.keys(props);
    var showEnvForm = envSupported && propKeys.length > 0;
    /* 配置表单：变量名 + 红星（必填）+ 描述行 + 输入框。旧版 label 只显示
     * description、placeholder 只显示变量名，用户看不出该填哪个键、填什么。 */
    var fields = showEnvForm ? propKeys.map(function (k) {
      var spec = props[k] || {};
      var rq = required.indexOf(k) >= 0;
      var hint = spec.description || spec['default'] || '';
      return '<label class="mcp-market-field">' +
        '<span class="mcp-market-field-key">' + esc(k) +
        (rq ? ' <b class="mcp-market-field-req" title="' + esc(m('required', '必填')) + '">*</b>' : '') +
        '</span>' +
        (hint ? '<span class="mcp-market-field-desc">' + esc(hint) + '</span>' : '') +
        '<input type="text" data-env="' + esc(k) + '" placeholder="' + esc(hint || k) + '"></label>';
    }).join('') : '';
    /* 详情徽标只保留「已认证」（厂商官方 verified 标记）。
     * 「精选」「已托管」概念已按用户拍板整体移除：官方目录取代精选，
     * 魔搭 hosted 专属 URL 未实现，展示「已托管」只会误导用户勾了连不上。 */
    var badges = '';
    if (d && d.is_verified) badges += '<span class="mcp-market-verified" title="verified">✓ ' + esc(m('verified', '已认证')) + '</span>';
    /* 授权形态徽标：从 server_config 的 auth 声明读 authType（非密钥），
     * 让用户连接前就知道要做什么：oauth=浏览器登录/扫码，qrcode_poll=扫码，
     * token=静态 Token。 */
    var authKind = canonicalAuthKind(detailAuthKind(d));
    if (authKind === 'qrcode_poll') badges += '<span class="mcp-market-scan-badge">' + esc(m('scan_badge', '扫码授权')) + '</span>';
    else if (authKind === 'oauth') badges += '<span class="mcp-market-badge-oauth">' + esc(m('oauth_badge', '登录/扫码授权')) + '</span>';
    else if (authKind === 'token') badges += '<span class="mcp-market-token-badge">' + esc(m('token_badge', 'Token')) + '</span>';
    var logo = (d && d.logo_url)
      ? '<img class="mcp-market-hero-logo" src="' + esc(d.logo_url) + '" alt="" onerror="this.remove()">'
      : '';
    if (!logo) {
      logo = '<div class="mcp-market-hero-logo mcp-market-logo-ph">' +
        esc((pickText(d, 'name') || id).charAt(0).toUpperCase()) + '</div>';
    }
    // 本地化 + 轻量安全 Markdown：不再 <pre> 原样输出上游 HTML table，也不再 slice(1200)
    var readmeHtml = renderReadme(pickReadme(d));
    modal.innerHTML = '' +
      '<div class="mcp-market-modal-box">' +
      '  <button type="button" class="mcp-market-modal-close" data-close aria-label="close">×</button>' +
      '  <div class="mcp-market-modal-body">' +
      '    <div class="mcp-market-hero">' + logo +
      '      <div class="mcp-market-hero-title">' + esc(m('connect_title', '连接')) + ' ' +
      esc(pickText(d, 'name') || id) + '</div>' +
      (badges ? '<div class="mcp-market-badges">' + badges + '</div>' : '') +
      '      <div class="mcp-market-hero-desc">' + esc(pickText(d, 'description')) + '</div>' +
      '      <button type="button" class="mcp-market-connect-btn" data-confirm data-id="' + esc(id) + '">' +
      esc(m('connect', '连接')) + '</button>' +
      '    </div>' +
      (fields ? '<div class="mcp-market-env"><div class="mcp-market-env-title">' +
        esc(m('config', '对接配置')) + '</div>' + fields + '</div>' : '') +
      (readmeHtml ? '<div class="mcp-market-readme">' + readmeHtml + '</div>' : '') +
      '  </div>' +
      '  <div class="mcp-market-modal-foot">' +
      '    <button type="button" class="mcp-market-cancel-btn" data-close>' + esc(m('cancel', '取消')) + '</button>' +
      '    <button type="button" class="mcp-market-install-btn" data-confirm data-id="' + esc(id) + '">' +
      esc(fields ? m('save_connect', '保存并连接') : m('connect', '连接')) + '</button>' +
      '  </div>' +
      '</div>';
    modal.setAttribute('data-current', id);
  }

  /**
   * 详情加载失败的弹窗形态。
   *
   * 2026-11 codereview 抓出的 P2：旧实现把裸错误文字直接塞进
   * `<div class="mcp-market-modal-box">上游超时</div>` —— 无关闭按钮、无内边距、
   * 无排版，与正常态形态割裂（Esc 与点遮罩仍能关，所以不卡死，但看着像坏了）。
   * 现改为与正常态同骨架的错误卡：关闭 × + 图标 + 文案 + 取消/重试。
   */
  function renderDetailError(modal, id, message) {
    modal.innerHTML = '' +
      '<div class="mcp-market-modal-box">' +
      '  <button type="button" class="mcp-market-modal-close" data-close aria-label="close">×</button>' +
      '  <div class="mcp-market-modal-body mcp-market-err-body">' +
      '    <div class="mcp-market-err-icon" aria-hidden="true">!</div>' +
      '    <div class="mcp-market-err-text">' +
      esc(tMsg('detail_failed', '加载详情失败：{msg}', message)) + '</div>' +
      '  </div>' +
      '  <div class="mcp-market-modal-foot">' +
      '    <button type="button" class="mcp-market-cancel-btn" data-close>' + esc(m('cancel', '取消')) + '</button>' +
      '    <button type="button" class="mcp-market-install-btn" data-retry data-id="' + esc(id) + '">' +
      esc(m('retry', '重试')) + '</button>' +
      '  </div>' +
      '</div>';
    modal.setAttribute('data-current', id);
  }

  function closeDetail() {
    var modal = document.getElementById('mcpMarketDetail');
    if (modal) { modal.style.display = 'none'; modal.innerHTML = ''; }
  }

  /* ═══ CLI 连接器（P0.5：扫码连接 + Node 自动安装）═══════════════════════
   *
   * 形态契约：官方列表 kind:"cli" / auth_kind:"cli_login" / tier:"cli"；
   * 详情含 cli_spec{package,version,binName,auth{argv,urlDomain,qrPngArg?},
   * authSteps?,status,unauth} + skills:[{name,dir}] + skills_zip(base64)。
   * 生命周期：cli/install（确保 node → npm 装 CLI → 落技能）→ cli/auth/start
   * （qrPng data URL 或 authorizationUrl）→ cli/auth/status 轮询到 granted。
   * 凭据由厂商 CLI 自管（Keychain/本地配置），前端不接触任何 token。 */

  /** cli_spec 的许可/来源展示行（package@version）。 */
  function cliPkgLine(d) {
    var spec = (d && d.cli_spec) || {};
    if (!spec.package) return '';
    return String(spec.package) + (spec.version ? '@' + String(spec.version) : '');
  }

  /** 技能名列表：skills:[{name,dir}] 只取 name（dir 是落盘目录，不外显）。 */
  function cliSkillNames(d) {
    var arr = (d && d.skills) || [];
    if (!Array.isArray(arr)) return [];
    return arr.map(function (s) {
      return typeof s === 'string' ? s : (s && s.name) || '';
    }).filter(Boolean);
  }

  /** CLI 详情弹窗：hero（logo/标题/扫码徽标/描述/连接主按钮）+ 技能清单 +
   *  许可来源行 + readme。已连接时主区显示「已连接」+「断开连接」入口。
   *  代际守卫与 showDetail 同口径（异步补查 cli/state 后须复核 seq）。 */
  async function renderCliDetail(modal, id, d, seq) {
    /* 先按缓存渲染（首绘无请求延迟），再补查权威态；已连接/未连接差异
     * 只影响按钮区，补查返回后就地重绘。 */
    var st = state.cliState[id] || null;
    function paint(cur) {
      var authorized = !!(cur && cur.authorized);
      var badges = '<span class="mcp-market-scan-badge">' +
        esc(authorized ? m('cli_connected', '已连接') : m('cli_badge', '扫码连接')) + '</span>';
      if (d && d.is_verified) badges = '<span class="mcp-market-verified" title="verified">✓ ' +
        esc(m('verified', '已认证')) + '</span>' + badges;
      var logo = (d && d.logo_url)
        ? '<img class="mcp-market-hero-logo" src="' + esc(d.logo_url) + '" alt="" onerror="this.remove()">'
        : '<div class="mcp-market-hero-logo mcp-market-logo-ph">' +
          esc((pickText(d, 'name') || id).charAt(0).toUpperCase()) + '</div>';
      var skillNames = cliSkillNames(d);
      var skillsHtml = skillNames.length
        ? '<div class="mcp-market-cli-skills"><div class="mcp-market-cli-skills-title">' +
          esc(m('cli_skills_included', '包含技能')) + '</div><ul class="mcp-market-cli-skills-list">' +
          skillNames.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') +
          '</ul></div>'
        : '';
      var pkg = cliPkgLine(d);
      var pkgHtml = pkg
        ? '<div class="mcp-market-cli-source">' + esc(m('cli_source', '来源与许可')) +
          '：<code>' + esc(pkg) + '</code></div>'
        : '';
      var readmeHtml = renderReadme(pickReadme(d));
      var heroBtn = authorized
        ? '<div class="mcp-market-cli-connected-tip">' + esc(m('cli_connected', '已连接')) + '</div>'
        : '<button type="button" class="mcp-market-connect-btn" data-cli-connect data-id="' + esc(id) + '">' +
          esc(m('cli_connect', '连接')) + '</button>';
      var footMain = authorized
        ? '<button type="button" class="mcp-market-cancel-btn mcp-market-cli-disconnect-btn" data-cli-disconnect data-id="' + esc(id) + '">' +
          esc(m('cli_disconnect', '断开连接')) + '</button>'
        : '<button type="button" class="mcp-market-install-btn" data-cli-connect data-id="' + esc(id) + '">' +
          esc(m('cli_connect', '连接')) + '</button>';
      modal.innerHTML = '' +
        '<div class="mcp-market-modal-box">' +
        '  <button type="button" class="mcp-market-modal-close" data-close aria-label="close">×</button>' +
        '  <div class="mcp-market-modal-body">' +
        '    <div class="mcp-market-hero">' + logo +
        '      <div class="mcp-market-hero-title">' + esc(m('connect_title', '连接')) + ' ' +
        esc(pickText(d, 'name') || id) + '</div>' +
        '      <div class="mcp-market-badges">' + badges + '</div>' +
        '      <div class="mcp-market-hero-desc">' + esc(pickText(d, 'description')) + '</div>' +
        heroBtn +
        '    </div>' +
        skillsHtml + pkgHtml +
        (readmeHtml ? '<div class="mcp-market-readme">' + readmeHtml + '</div>' : '') +
        '  </div>' +
        '  <div class="mcp-market-modal-foot">' +
        '    <button type="button" class="mcp-market-cancel-btn" data-close>' + esc(m('cancel', '取消')) + '</button>' +
        footMain +
        '  </div>' +
        '</div>';
      modal.setAttribute('data-current', id);
    }
    paint(st);
    try {
      var fresh = await api(API.cliState + '?id=' + encodeURIComponent(id));
      if (seq !== state.detailSeq) return;   // 用户已点开别的详情：过期态丢弃
      state.cliState[id] = fresh || {};
      paint(state.cliState[id]);
    } catch (_) { /* 状态查询失败按未连接展示，连接流程里后端还会复核 */ }
  }

  /* ── CLI 连接流程弹窗 ─────────────────────────────────────────────────
   * 复用 McpAuth 等待框视觉语言（.mcp-auth-overlay/.mcp-auth-dialog，
   * mcp-auth.css 两壳全局加载），但节点独立（#mcpCliFlowOverlay），不与
   * McpAuth 的 #mcpAuthOverlay/generation 互相干扰。
   *
   * 状态机：install(POST cli/install → 1s 轮询 install/status：
   *   node[进度条] → npm → skills → done)
   *   → auth(POST cli/auth/start → qrPng 直接 img / authorizationUrl 走
   *     window.QRCode 本地绘制【与 McpAuth showQrCodeModal 同一管线】
   *     → 2s 轮询 auth/status：pending/waiting_url[换码]/granted/failed/expired)
   * 全程 per-id 在途锁（installing 机制），连点忽略；关闭/Escape = auth/cancel。 */

  var cliFlow = null;   // {id, gen, timer, view, authStarted, granted, pollErrs, lastPhase}

  function cliFlowOverlay() { return document.getElementById('mcpCliFlowOverlay'); }

  /** urlDomain / 授权 URL → 扫码 App 名（契约域白名单映射）。 */
  function cliScanApp(domainOrUrl) {
    var h = String(domainOrUrl == null ? '' : domainOrUrl).toLowerCase();
    try { if (h.indexOf('://') >= 0) h = new URL(h).hostname; } catch (_) { /* 非 URL 按域名字面量匹配 */ }
    if (/(^|\.)dingtalk\.com$/.test(h)) return m('cli_app_dingtalk', '钉钉');
    if (/(^|\.)weixin\.qq\.com$/.test(h)) return m('cli_app_wecom', '企业微信');
    if (/(^|\.)feishu\.cn$/.test(h)) return m('cli_app_feishu', '飞书');
    if (/(^|\.)meeting\.tencent\.com$/.test(h)) return m('cli_app_tmeet', '腾讯会议');
    return '';
  }

  /** cli_spec 声明的授权域：顶层 auth.urlDomain，或多步 authSteps 的首个域；
   *  都没有时以运行时授权 URL 实测为准（applyCliAuthPayload 兜底）。 */
  function cliSpecDomain(d) {
    try {
      var spec = (d && d.cli_spec) || {};
      if (spec.auth && spec.auth.urlDomain) return String(spec.auth.urlDomain);
      var steps = spec.authSteps;
      if (Array.isArray(steps)) {
        for (var i = 0; i < steps.length; i++) {
          if (steps[i] && steps[i].urlDomain) return String(steps[i].urlDomain);
        }
      }
    } catch (_) { /* 形状异常时走 URL 实测 */ }
    return '';
  }

  /** 已知官方 CLI 连接器 id → App 名（qrPng 直给且无 URL 可测时的兜底，
   *  与 registry 首批 4 条的 urlDomain 映射同口径）。 */
  function cliAppById(id) {
    var s = String(id || '');
    if (/dingtalk/i.test(s)) return m('cli_app_dingtalk', '钉钉');
    if (/wecom/i.test(s)) return m('cli_app_wecom', '企业微信');
    if (/feishu|lark/i.test(s)) return m('cli_app_feishu', '飞书');
    if (/tmeet/i.test(s)) return m('cli_app_tmeet', '腾讯会议');
    return '';
  }

  /** 协议白名单：仅 http(s)。外链与 QRCode 绘制共用同一判据，防止
   *  javascript:/data: 经 authorizationUrl 注入 <a href> 或二维码内容。 */
  function cliAllowedUrl(url) {
    var u = String(url || '');
    return /^https?:\/\//i.test(u) ? u : '';
  }

  /** 外链只放行 http(s)，target=_blank rel=noopener noreferrer —— 与 McpAuth
   *  safeExternal 同口径；桌面壳 EXTERNAL-LINK-GUARD/on_new_window 转系统浏览器。 */
  function cliSafeExternal(url, text) {
    var safe = cliAllowedUrl(url);
    if (!safe) return '';
    return '<a class="mcp-auth-help-link" href="' + esc(safe) +
      '" target="_blank" rel="noopener noreferrer">' + esc(text) + '</a>';
  }

  function cliFlowPaint(view) {
    var f = cliFlow;
    if (!f) return false;
    f.view = view;
    var body = document.getElementById('mcpCliFlowBody');
    var foot = document.getElementById('mcpCliFlowFoot');
    if (!body || !foot) return true;
    var cancelBtn = '<button type="button" class="mcp-auth-btn mcp-auth-btn-ghost" data-cli-flow-close>' +
      esc(m('cancel', '取消')) + '</button>';
    var html = '', footer = cancelBtn;
    if (view.kind === 'install') {
      var label = view.phase === 'npm' ? m('cli_installing_cli', '正在安装连接器组件')
        : view.phase === 'skills' ? m('cli_installing_skills', '正在安装技能')
        : m('cli_preparing_node', '正在准备 Node 运行时');
      html = '<div class="mcp-auth-status"><span class="mcp-auth-status-dot mcp-auth-status-dot-busy"></span><span>' +
        esc(label) + '</span></div>';
      if (view.phase === 'node') {
        var pct = Math.max(0, Math.min(100, Number(view.progress) || 0));
        html += '<div class="mcp-cli-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '">' +
          '<div class="mcp-cli-progress-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="mcp-cli-progress-num">' + pct + '%</div>';
      }
    } else if (view.kind === 'waiting') {
      html = '<div class="mcp-auth-status"><span class="mcp-auth-status-dot mcp-auth-status-dot-busy"></span><span>' +
        esc(m('cli_auth_pending', '等待扫码授权…')) + '</span></div>';
    } else if (view.kind === 'qr') {
      var app = view.app || '';
      var scanText = app
        ? tMsg('cli_scan_with', '请用{msg}扫码', app)
        : m('cli_scan_generic', '请用对应 App 扫码并确认授权');
      html = '<div class="mcp-auth-status"><span class="mcp-auth-status-dot mcp-auth-status-dot-busy"></span><span>' +
        esc(m('cli_auth_pending', '等待扫码授权…')) + '</span></div>' +
        '<div class="mcp-auth-qr-canvas" id="mcpCliQrCanvas"></div>' +
        '<div class="mcp-auth-help-text">' + esc(scanText) + '</div>' +
        cliSafeExternal(view.url, m('cli_open_browser', '在浏览器中打开'));
    } else if (view.kind === 'success') {
      html = '<div class="mcp-auth-status"><span class="mcp-auth-status-dot"></span><span>' +
        esc(m('cli_auth_success', '连接成功')) + '</span></div>';
      footer = '<button type="button" class="mcp-auth-btn mcp-auth-btn-primary" data-cli-flow-close>' +
        esc(t('settings.mcp.common_close', '关闭')) + '</button>';
    } else if (view.kind === 'error') {
      html = '<div class="mcp-auth-error" style="display:block">' + esc(view.msg || '') + '</div>';
      footer = cancelBtn + '<button type="button" class="mcp-auth-btn mcp-auth-btn-primary" data-cli-flow-retry>' +
        esc(m('retry', '重试')) + '</button>';
    }
    body.innerHTML = html;
    foot.innerHTML = footer;
    /* 二维码渲染：qrPng（企微 --output-qrcode 的 data URL）直接 img；
     * authorizationUrl 用全局 QRCode（qrcode.min.js，index.html 已加载）
     * 本地绘制 —— 与 McpAuth showQrCodeModal 完全同一管线与参数。
     * QRCode 缺失且外链安全时降级为纯外链，不阻断授权。
     * P2：qrPng 非法且无安全 authorizationUrl 时画布/外链都空，旧版停在
     * 「等待扫码授权…」直到后端 10 分钟 expired —— 改为显式 error 态（可重试）。 */
    if (view.kind === 'qr') {
      var el = document.getElementById('mcpCliQrCanvas');
      if (el) {
        var pngOk = !!(view.qrPng && /^data:image\/(png|jpe?g|webp);base64,/i.test(String(view.qrPng)));
        var safeUrl = cliAllowedUrl(view.url);
        var usable = pngOk || !!safeUrl;   // 有合法二维码图或至少一条安全外链
        if (pngOk) {
          el.innerHTML = '<img src="' + esc(view.qrPng) + '" alt="QR">';
        } else if (safeUrl && window.QRCode) {
          try {
            el.innerHTML = '';
            /* 与 cliSafeExternal 同一协议白名单：非 http(s) 绝不交给 QRCode。 */
            new window.QRCode(el, {
              text: safeUrl, width: 220, height: 220,
              colorDark: '#000000', colorLight: '#ffffff',
              correctLevel: window.QRCode.CorrectLevel.M
            });
          } catch (_) { /* 绘制失败仍有安全外链兜底 */ }
        }
        if (!usable) {
          /* 二维码既不是合法 data URL、也没有 http(s) 外链：画布与外链都空，
           * 旧版会一直停在「等待扫码授权…」直到后端 10 分钟 expired。
           * 立即落显式 error 态（可重试），并返回 false 让调用方停止轮询。 */
          cliFlowError(f, f.gen, m('cli_qr_invalid', '二维码无效，请重试'), 'auth');
          return false;
        }
      }
    }
    return true;
  }

  function cliFlowAlive(f, gen) { return !!cliFlow && cliFlow === f && f.gen === gen; }

  function cliFlowError(f, gen, msg, retry) {
    if (!cliFlowAlive(f, gen)) return;
    /* 失败态必须停轮询 + 释放在途锁：否则卡片「+」/详情按钮永久 disabled，
     * 用户除弹窗内「重试」外无任何出口（P2 卡死缺陷）。成功态由 granted
     * 分支另设 1200ms 自动关闭定时器，不受这里影响。 */
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    if (!f.granted) setInstalling(f.id, false);
    cliFlowPaint({ kind: 'error', msg: msg, retry: retry });
  }

  /** 阶段 1：触发安装并轮询（1s）。node 阶段画进度条，failed 显示 error+重试。 */
  async function runCliInstall() {
    var f = cliFlow;
    if (!f) return;
    var gen = f.gen;
    f.lastPhase = 'node';
    cliFlowPaint({ kind: 'install', phase: 'node', progress: 0 });
    try {
      await api(API.cliInstall, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id }),
      });
    } catch (e) {
      cliFlowError(f, gen, tMsg('cli_install_failed', '连接器安装失败：{msg}', e.message), 'install');
      return;
    }
    if (!cliFlowAlive(f, gen)) return;
    pollCliInstall(f, gen);
  }

  function pollCliInstall(f, gen) {
    if (!cliFlowAlive(f, gen)) return;
    f.timer = setTimeout(async function () {
      if (!cliFlowAlive(f, gen)) return;
      var st;
      try {
        st = await api(API.cliInstallStatus + '?id=' + encodeURIComponent(f.id));
        f.pollErrs = 0;
      } catch (e) {
        /* 轮询瞬时失败不立刻判死（安装任务在后端继续跑）；连续 3 次才报错。 */
        f.pollErrs = (f.pollErrs || 0) + 1;
        if (f.pollErrs >= 3) {
          cliFlowError(f, gen, tMsg('cli_install_failed', '连接器安装失败：{msg}', e.message), 'install');
          return;
        }
        pollCliInstall(f, gen);
        return;
      }
      if (!cliFlowAlive(f, gen)) return;
      var phase = (st && st.phase) || '';
      if (phase === 'failed') {
        var err = (st && st.error) || '';
        cliFlowError(f, gen, f.lastPhase === 'node'
          ? tMsg('cli_node_failed', 'Node 运行时准备失败：{msg}', err)
          : tMsg('cli_install_failed', '连接器安装失败：{msg}', err), 'install');
        return;
      }
      if (phase === 'done') { beginCliAuth(); return; }
      f.lastPhase = phase || f.lastPhase;
      cliFlowPaint({ kind: 'install', phase: phase || 'node', progress: (st && st.nodeProgress) || 0 });
      pollCliInstall(f, gen);
    }, 1000);
  }

  /** 阶段 2：install done → auth/start → 二维码/等待态。 */
  async function beginCliAuth() {
    var f = cliFlow;
    if (!f) return;
    var gen = f.gen;
    cliFlowPaint({ kind: 'waiting' });
    var r;
    try {
      r = await api(API.cliAuthStart, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id }),
      });
    } catch (e) {
      cliFlowError(f, gen, tMsg('cli_auth_failed', '授权失败：{msg}', e.message), 'auth');
      return;
    }
    if (!cliFlowAlive(f, gen)) return;
    f.authStarted = true;
    /* start 同步返回失败态（后端可能用 state 或 phase 字段，如「尚未安装」）
     * 时不能只靠轮询发现：立即落 error，避免停在「等待扫码」白等。 */
    if (r && (r.state === 'failed' || r.state === 'expired' ||
              r.phase === 'failed' || r.phase === 'expired')) {
      cliFlowError(f, gen, tMsg('cli_auth_failed', '授权失败：{msg}', r.error || ''), 'auth');
      return;
    }
    if (!applyCliAuthPayload(f, r)) return;   // 畸形二维码：已落 error 态，不再轮询
    pollCliAuth(f, gen);
  }

  /** auth/start 与 auth/status 的载荷统一落画：qrPng 直接 img；
   *  authorizationUrl 本地画码；session:true（企微先起会话后出码）→ 等待态。
   *  返回 false 表示载荷无法展示（已落 error 态），调用方不得继续轮询。 */
  function applyCliAuthPayload(f, r) {
    var d = state.detailCache[f.id];
    var specApp = cliScanApp(cliSpecDomain(d));
    if (r && r.qrPng) {
      return cliFlowPaint({
        kind: 'qr', qrPng: String(r.qrPng), url: r.authorizationUrl || '',
        app: specApp || cliScanApp(r.authorizationUrl || '') || cliAppById(f.id),
      });
    }
    if (r && r.authorizationUrl) {
      return cliFlowPaint({ kind: 'qr', url: String(r.authorizationUrl), app: cliScanApp(r.authorizationUrl) || specApp || cliAppById(f.id) });
    }
    return cliFlowPaint({ kind: 'waiting' });
  }

  /** 阶段 3：轮询 auth/status（2s）。waiting_url=多步 auth 当前步完成 → 换码。 */
  function pollCliAuth(f, gen) {
    if (!cliFlowAlive(f, gen)) return;
    f.timer = setTimeout(async function () {
      if (!cliFlowAlive(f, gen)) return;
      var st;
      try {
        st = await api(API.cliAuthStatus + '?id=' + encodeURIComponent(f.id));
        f.pollErrs = 0;
      } catch (e) {
        f.pollErrs = (f.pollErrs || 0) + 1;
        if (f.pollErrs >= 3) {
          cliFlowError(f, gen, tMsg('cli_auth_failed', '授权失败：{msg}', e.message), 'auth');
          return;
        }
        pollCliAuth(f, gen);
        return;
      }
      if (!cliFlowAlive(f, gen)) return;
      var s = (st && st.state) || 'pending';
      if (s === 'granted') {
        f.granted = true;
        /* granted 只代表后端会话成功；权威态以 cli/state 为准，
         * 不写死字面量，避免后续 hydrate 失败时留下假阳性「已连接」。 */
        try {
          var authoritative = await api(API.cliState + '?id=' + encodeURIComponent(f.id));
          if (!cliFlowAlive(f, gen)) return;
          if (authoritative && typeof authoritative.authorized === 'boolean') {
            state.cliState[f.id] = authoritative;
          } else {
            /* 响应为空/形状异常：清掉缓存，让 hydrateCliStates 重查，
             * 绝不留下 granted 乐观写入的假阳性「已连接」。 */
            delete state.cliState[f.id];
          }
        } catch (_) {
          if (!cliFlowAlive(f, gen)) return;
          delete state.cliState[f.id];
        }
        cliFlowPaint({ kind: 'success' });
        closeDetail();
        if (state.root) { cards(); load(); }
        if (window._skills && window._skills.refresh) window._skills.refresh();
        if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
        /* 成功态短暂停留后自动关闭（granted 不触发 cancel）。 */
        f.timer = setTimeout(function () {
          if (!cliFlowAlive(f, gen)) return;
          closeCliFlow();
        }, 1200);
        return;
      }
      if (s === 'failed') {
        cliFlowError(f, gen, tMsg('cli_auth_failed', '授权失败：{msg}', (st && st.error) || ''), 'auth');
        return;
      }
      if (s === 'expired') {
        cliFlowError(f, gen, m('cli_auth_expired', '二维码已过期，请重试'), 'auth');
        return;
      }
      if (s === 'waiting_url' || (st && (st.qrPng || st.authorizationUrl))) {
        if (!applyCliAuthPayload(f, st)) return;   // 换码载荷畸形：停在 error 态
      }
      pollCliAuth(f, gen);
    }, 2000);
  }

  /** 打开连接流程弹窗。per-id 在途锁 + 单弹窗约束：在途/已有流程时连点忽略。 */
  function startCliFlow(id) {
    if (!id || installing[id] || cliFlow) return;
    var d = state.detailCache[id] || null;
    var it = null;
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) { it = state.items[i]; break; }
    var name = pickText(d || it, 'name') || id;
    setInstalling(id, true);
    cliFlow = { id: id, gen: 1, timer: null, view: null, authStarted: false, granted: false, pollErrs: 0, lastPhase: 'node' };
    var ov = document.createElement('div');
    ov.className = 'mcp-auth-overlay';
    ov.id = 'mcpCliFlowOverlay';
    ov.innerHTML = '' +
      '<div class="mcp-auth-dialog" role="dialog" aria-modal="true">' +
      '  <div class="mcp-auth-header"><span class="mcp-auth-title">' +
      esc(m('connect_title', '连接')) + ' ' + esc(name) + '</span>' +
      '    <button type="button" class="mcp-auth-close" data-cli-flow-close aria-label="close">&times;</button></div>' +
      '  <div class="mcp-auth-body" id="mcpCliFlowBody"></div>' +
      '  <div class="mcp-auth-footer" id="mcpCliFlowFoot"></div>' +
      '</div>';
    document.body.appendChild(ov);
    /* 弹窗节点随开随建、随关随毁，委托绑一次即可（无 render 累积问题）。 */
    ov.addEventListener('click', function (e) {
      var t2 = e.target;
      if (t2 === ov) { closeCliFlow(); return; }
      if (t2 && t2.closest && t2.closest('[data-cli-flow-retry]')) { retryCliFlow(); return; }
      if (t2 && t2.closest && t2.closest('[data-cli-flow-close]')) { closeCliFlow(); return; }
    });
    runCliInstall();
  }

  /** 关闭 = cancel（仅授权会话已开始且未 granted 时发 auth/cancel；
   *  安装阶段无 cancel 端点，后端任务自然结束）。释放在途锁。 */
  function closeCliFlow() {
    var f = cliFlow;
    if (!f) return;
    cliFlow = null;
    f.gen++;
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    var ov = cliFlowOverlay();
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    setInstalling(f.id, false);
    if (f.authStarted && !f.granted) {
      /* 记录 cancel 的 Promise：retry 必须 await 它完成后才能重新 start，
       * 否则旧 cancel 与后端 start_auth 内部的 cancel_auth 乱序，
       * 新会话会被旧 cancel 置 failed（P1 竞态）。 */
      f.cancelPromise = api(API.cliAuthCancel, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id }),
      }).catch(function () { /* cancel 尽力而为 */ });
    }
  }

  /** 错误态重试：install 失败重跑安装；auth 失败/过期先 await cancel 旧会话，
   *  再重新 start（cancel 与 start 乱序会让新会话被旧 cancel 置 failed）。
   *  cancel 的 Promise 纳入代际守卫：新 gen 期间被关闭则不再 start。 */
  async function retryCliFlow() {
    var f = cliFlow;
    if (!f || !f.view || f.view.kind !== 'error') return;
    var gen = ++f.gen;
    if (f.timer) { clearTimeout(f.timer); f.timer = null; }
    f.pollErrs = 0;
    var retry = f.view.retry;
    /* 失败态已释放在途锁；重试重新占用，成功/关闭/再次失败路径负责释放。 */
    setInstalling(f.id, true);
    if (retry === 'auth') {
      var cancel = null;
      if (f.authStarted || f.cancelPromise) {
        /* 复用 closeCliFlow 遗留的 cancelPromise（若有），否则现发一个；
         * 两者都必须 await 完成，且不允许 fire-and-forget。 */
        cancel = f.cancelPromise || api(API.cliAuthCancel, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: f.id }),
        }).catch(function () {});
        f.cancelPromise = cancel;
        await cancel;
      }
      if (!cliFlowAlive(f, gen)) return;   // 新 gen 期间被关闭/切源：不再 start
      f.cancelPromise = null;
      f.authStarted = false;
      beginCliAuth();
    } else {
      runCliInstall();
    }
  }

  /** 详情「断开连接」：cli/uninstall（登出 + 移除技能），成功后刷新卡片与详情。 */
  async function cliDisconnect(id) {
    if (!id || installing[id]) return;
    var d = state.detailCache[id];
    var name = pickText(d, 'name') || id;
    if (typeof window.confirm === 'function' &&
        !window.confirm(tMsg('cli_disconnect_confirm', '确定断开连接「{msg}」？将登出并移除随附技能。', name))) return;
    setInstalling(id, true);
    try {
      await api(API.cliUninstall, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id }),
      });
      state.cliState[id] = { installed: false, authorized: false, nodeReady: true };
      toast(m('cli_disconnected', '已断开连接'), 'success');
      if (state.root) cards();
      var modal = document.getElementById('mcpMarketDetail');
      if (modal && modal.style.display === 'flex' && modal.getAttribute('data-current') === id) showDetail(id);
    } catch (e) {
      toast(tMsg('cli_disconnect_failed', '断开连接失败：{msg}', e.message), 'error');
    } finally {
      setInstalling(id, false);
    }
  }

  function collectEnv(modal) {
    var env = {};
    modal.querySelectorAll('[data-env]').forEach(function (i) {
      env[i.getAttribute('data-env')] = i.value;
    });
    return env;
  }

  async function confirmInstall() {
    var modal = document.getElementById('mcpMarketDetail');
    if (!modal) return;
    var id = modal.getAttribute('data-current');
    await install(id, collectEnv(modal));
  }

  /* 安装在途锁（per-id）：install 是「取详情 → auth.state → POST」的异步链，
   * 连点 `+` 或弹窗「连接」会并发提交，第二个请求撞后端重名 400，用户看到
   * 「已安装」紧跟「安装失败」。CSS 里 .installing 态早已备好，这里接上。 */
  var installing = {};
  function setInstalling(id, on) {
    if (on) installing[id] = true; else delete installing[id];
    var root = state.root || document;
    root.querySelectorAll('.mcp-market-card-add[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]')
      .forEach(function (b) { b.classList.toggle('installing', !!on); b.disabled = !!on; });
    var modal = document.getElementById('mcpMarketDetail');
    if (modal) modal.querySelectorAll('[data-confirm],[data-retry],[data-cli-connect],[data-cli-disconnect]').forEach(function (b) {
      b.classList.toggle('installing', !!on); b.disabled = !!on;
    });
  }

  async function install(id, env) {
    if (!id) return;
    if (installing[id]) return;            // 在途：连点直接忽略
    /* CLI 条目分流：kind=cli 走「安装+扫码」流程弹窗，绝不进 MCP 安装链
     * （market/install 对 CLI 条目无意义）。kind 在列表 item 与详情上都有；
     * 列表未命中时查 detailCache / 拉详情判定（详情必有 kind）。 */
    var listed = null;
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) { listed = state.items[i]; break; }
    var kindKnown = listed || state.detailCache[id];
    if (!kindKnown) {
      try {
        kindKnown = await api(API.detail + '?id=' + encodeURIComponent(id));
        state.detailCache[id] = kindKnown;
      } catch (_) { /* 详情失败按 MCP 原流程走（错误提示由原链路负责） */ }
    }
    if (isCliItem(kindKnown)) { startCliFlow(id); return; }
    setInstalling(id, true);
    try {
      // 详情弹窗会带 env；卡片直装时先取详情，若存在必填 env 则弹出表单让用户补，
      // 而不是把空值直接提交给后端（后端会 400 提示缺哪些键）。
      if (!env) {
        var d = state.detailCache[id] || await api(API.detail + '?id=' + encodeURIComponent(id));
        state.detailCache[id] = d;
        var required = ((d && d.env_schema && d.env_schema.required) || []);
        if (required.length) { await showDetail(id); return; }
        env = {};
      }
      /* 认证分流：先用 /auth/state?name= 判断分支。
       * 后端 /auth/state|token|start 都要求连接器已落 settings.json，
       * 因此「新装」必须先 install 再弹认证框；已装（state.ok）则先弹框，
       * 认证成功后继续原安装流程。authType == 'none' 时原流程一字不改。 */
      var auth = window.McpAuth || {};
      var proceed = true;
      if (typeof auth.state === 'function') {
        var st = await auth.state(id).catch(function () { return null; });
        if (st && st.ok && st.authType && st.authType !== 'none' && st.needsAuth
            && typeof auth.openDialog === 'function') {
          proceed = await auth.openDialog(id, function () {
            if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
          });
          if (!proceed) return;               // 弹窗已接管，认证未完成不提交
        }
      }
      var data = await submitInstall(id, env);
      /* 新装落盘后再查一次：此刻 /auth/state 才认识这个连接器。用后端返回的
       * 真实 installed 名称（不是市场 id）逐个判断；needsAuth 为真则弹出
       * token 模态框 / OAuth 等待框，成功后刷新列表（重新连接）。 */
      var names = (data && data.installed) || [];
      if (proceed && typeof auth.openDialog === 'function' && typeof auth.state === 'function') {
        names.forEach(function (name) {
          /* 只对确实需要认证的连接器弹框：已装且已有凭据时保持「已连接」安静态，
           * 不打断用户（重新连接 / 清除凭据入口在手动表单编辑时提供）。 */
          Promise.resolve(auth.state(name)).then(function (st) {
            if (!st || !st.ok || !st.needsAuth) return null;
            return auth.openDialog(name, function () {
              if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
              if (window._skills && window._skills.refresh) window._skills.refresh();
            });
          }).catch(function () {});
        });
      }
    } catch (e) {
      toast(tMsg('install_failed', '安装失败：{msg}', e.message), 'error');
    } finally {
      setInstalling(id, false);
    }
  }

  /** 原安装请求体（env_schema 输入与提示完全保持原样）。 */
  async function submitInstall(id, env) {
    var data = await api(API.install, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, env: env }),
    });
    var names = (data && data.installed) || [];
    toast(names.length
      ? tMsg('installed_names', '已安装：{msg}', names.join(', '))
      : m('installed', '已安装'), 'success');
    closeDetail();
    if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
    if (window._skills && window._skills.refresh) window._skills.refresh();
    return data;
  }

  // ─── 对外 ────────────────────────────────────────────────────────────────
  window._mcpMarket = {
    setHost: function (selector) {
      state.root = typeof selector === 'string' ? document.querySelector(selector) : selector;
    },
    load: async function () {
      if (!state.root) return;
      if (!state.categories.length) await loadCategories();
      await load();
    },
    search: function (kw) { state.search = kw || ''; state.page = 1; return load(); },
    /* 只重置查询词、不发请求：主 tab / 二级视图切换时用来作废幽灵过滤，
     * 真正的重查由切换流程里那次 load() 统一发出（避免重复请求）。 */
    clearSearch: function () { state.search = ''; state.page = 1; },
    showDetail: showDetail,
    install: install,
    /* CLI 连接器对外面：连接流程弹窗 / 断开 / 关闭（Escape 与测试用）。 */
    connectCli: startCliFlow,
    disconnectCli: cliDisconnect,
    closeCliFlow: closeCliFlow,
    refresh: function () { return load(); },
    /* 无限滚动对外面：技能页滚动分派与「没有更多」判定用。 */
    hasMore: function () { return hasMorePages(); },
    loadMore: loadMore,
  };

  // Escape 关闭弹窗（与技能详情弹窗同体验）。持久节点一次性绑定，不随 render 累积。
  // CLI 连接流程弹窗优先：Escape = 关闭并 cancel 授权会话。
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (cliFlow) { closeCliFlow(); return; }
    var modal = document.getElementById('mcpMarketDetail');
    if (modal && modal.style.display !== 'none' && modal.style.display !== '') closeDetail();
  });

  window.addEventListener('i18n:localeChanged', function () {
    if (state.root) render();
    /* 弹窗已提升为持久节点，render() 不再重建它 —— 语言切换后若弹窗正开着，
     * 里面的名称/描述/readme 会停留在旧语言。用 detailCache 就地重绘（不重发请求）。 */
    var modal = document.getElementById('mcpMarketDetail');
    if (modal && modal.style.display === 'flex') {
      var id = modal.getAttribute('data-current');
      if (id) showDetail(id);
    }
    /* CLI 连接流程弹窗：按当前视图就地重绘（轮询/会话不受影响）。 */
    if (cliFlow && cliFlow.view) cliFlowPaint(cliFlow.view);
  });
})();
