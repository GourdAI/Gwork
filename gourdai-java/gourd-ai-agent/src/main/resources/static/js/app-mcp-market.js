/* =============================================================================
 * app-mcp-market.js — 「连接器」页目录（三个内置源：魔搭 / 腾讯云 / Smithery）
 *
 * 2026-11 集成 SolonCode v2026.11 连接器市场：新增腾讯云 MCP 广场（SolonCode
 * 默认源）与 Smithery 注册表两个目录源，魔搭保留为默认。源切换与技能页
 * 「已安装/各市场」同构：二级导航 = 已安装 / 魔搭 / 腾讯云 / Smithery
 * （app-skills.js renderConnTabs），「广场」这个中间层概念退役。
 * 顶栏「+ 添加服务器」（自定义 MCP）在全部连接器视图可见（用户报障：
 * 广场视图找不到添加自定义 MCP 的入口）。
 *
 * 已删除且不得复活：自建官方源（official）、厂商 CLI 连接器流程、
 * 「精选/已托管」概念、registry_error 软失败空态。
 *
 * 后端：GET  /web/settings/mcp/market/servers?source=&search=&page=&pageSize=&category=
 *       GET  /web/settings/mcp/market/detail?id=   （源由 id 前缀分流：tencent:/smithery:）
 *       GET  /web/settings/mcp/market/categories?source=
 *       POST /web/settings/mcp/market/install  {id, env}
 *
 * 分页窗口按源：魔搭 100 条硬窗口；腾讯云/Smithery 无窗口（total_count 驱动）。
 * 不硬编码任何 Token。
 * ========================================================================== */
(function () {
  'use strict';

  var API = {
    servers: '/web/settings/mcp/market/servers',
    detail: '/web/settings/mcp/market/detail',
    categories: '/web/settings/mcp/market/categories',
    install: '/web/settings/mcp/market/install',
    /* stdio 运行时（uv/Node）检测与代装（2026-11「program not found」报障轮；
     * 同日用户二次拍板「缺少环境就自动安装，交互上只提示正在下载运行环境，
     * 不要再让用户确认点击；运行环境装好并重连成功，整个连接器才算安装
     * 完成」）。链路：缺运行时 → 进度弹窗自动 POST install → status 轮询 →
     * done 后 toggle 重连，全部成功才报安装完成。失败才给重试/关闭。 */
    runtimeCheck: '/web/settings/mcp/runtime/check',
    runtimeInstall: '/web/settings/mcp/runtime/install',
    runtimeStatus: '/web/settings/mcp/runtime/status',
    /* 已落盘连接器名单（与 app-settings-mcp.js loadMcpList 同一端点）。
     * 响应 {code:200, data:[{name, marketId, ...}]}，data 是数组不是对象。 */
    installed: '/web/settings/mcp/servers',
  };

  /** 卡片 `+` 号安装按钮的图标。与技能卡 .skill-card-add 的 SVG **逐字节一致**
   *  （skills.css:196 / app-skills.js syncInstalledBadges），保证同页两种卡片的
   *  安装入口视觉同源；改这里必须同步改那边，否则形态又开始割裂。 */
  var PLUS_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  /** 已安装卡片右上角的对勾图标（替换 + 号，disabled 态）。 */
  var CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="20 6 9 17 4 12"/></svg>';

  /* 内置目录源白名单（与后端 normalize_source 同口径）。展示名走
   * settings.mcp.market.source_* 键；未知值一律回落魔搭。 */
  var SOURCES = ['modelscope', 'tencent', 'smithery'];

  var state = {
    root: null,
    /* 当前目录源：modelscope（默认）/ tencent / smithery。
     * 列表与分类查询携带 source；详情/安装由 id 前缀分流（后端 source_of_id），
     * 因此 detailCache / installedIndex 的 key 天然跨源不撞。 */
    source: 'modelscope',
    search: '',
    category: '',
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
    /* 已安装索引：marketId → true。市场条目的落盘名来自详情 server_config 的
     * mcpServers keys（多为 fetch/time 等通用名，重名安装还会加 -2 后缀），
     * 按名字匹配必然误判；后端 install 落盘 marketId=目录条目 id（非密钥，
     * build_entry 透传、/web/settings/mcp/servers 回传），这里是唯一可靠口径。
     * 拉取失败时保持空索引 = 全部按未安装渲染（静默降级，不拖垮广场加载）。 */
    installedIndex: {},
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
  /** 目录图标经内核代理加载（与 app-settings-mcp.js mcpIconSrc 同一端点）：
   *  腾讯云 CDN 有 Referer 防盗链、Smithery 图标在境外域名，WebView 直连
   *  <img> 常 403/超时。内核 fetch_icon 逐跳校验 scheme/host（SSRF 门禁）
   *  并带回 image/* Content-Type。__gworkApiUrl 在桌面壳里补内核绝对地址。 */
  function proxyIcon(url) {
    if (!url) return '';
    var path = '/web/settings/skills/icon?url=' + encodeURIComponent(url);
    return (typeof window.__gworkApiUrl === 'function') ? window.__gworkApiUrl(path) : path;
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
    p.set('source', state.source);
    if (state.search) p.set('search', state.search);
    p.set('page', String(state.page));
    p.set('pageSize', String(state.pageSize));
    if (state.category) p.set('category', state.category);
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
     * 列表无限滚动，底部 #mcpMarketSentinel 交给 IntersectionObserver
     * 触发 loadMore。 */
    var catsBar = document.getElementById('mcpMarketCatBar');
    if (catsBar) catsBar.innerHTML = cats;
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
   * 后端按规范形态处理，卡片徽标必须同口径，否则「后端要授权、卡片无徽标」。
   * 注：qrcode_poll/qrcode/qr_poll/scan 一族已随自建官方源下线，后端 AuthKind
   * 把它们归入 None（= 无授权、直接连接），故此处不再识别、徽标也不画——同口径。 */
  function canonicalAuthKind(k) {
    k = String(k || '').trim().toLowerCase();
    if (k === 'oauth' || k === 'oauth2' || k === 'browser' || k === 'login') return 'oauth';
    if (k === 'token' || k === 'static' || k === 'apikey' || k === 'api_key') return 'token';
    return k;
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
      /* 默认图标与技能卡同款（用户拍板「连接器没图片要有默认的，和技能一样，
       * 显示名字图片」）：名字前两字母做底，代理 <img> 叠在上面，加载失败
       * onerror 自毁露出字母底——不再是硬编码 "M"，也不是失败后整块消失。 */
      var displayName = pickText(it, 'name') || it.id || 'M';
      var letter = esc(String(displayName).substring(0, 2).toUpperCase());
      var logo = '<div class="mcp-market-logo mcp-market-logo-ph"><span>' + letter + '</span>' +
        (it.logo_url
          ? '<img src="' + esc(proxyIcon(it.logo_url)) + '" alt="" loading="lazy" onerror="this.remove()">'
          : '') +
        '</div>';
      /* 列表接口（PUT /mcp/servers）实测只返回：
       *   id, publisher, name, chinese_name, description, tags, logo_url,
       *   view_count, locales, categories, auth_kind
       * **不含** is_hosted / is_verified —— 那两个字段只在详情接口里有。
       * 所以卡片不画认证 badge（否则永远不显示，是死代码），改画真实存在的
       * categories + 授权形态徽标；is_verified 在详情弹窗显示。 */
      var meta = [];
      if (Array.isArray(it.categories) && it.categories.length) meta.push(esc(catName(it.categories[0])));
      if (it.view_count != null) meta.push(esc(shortNum(it.view_count)));
      /* 授权形态徽标：oauth=登录/扫码授权；token=静态 Token。魔搭条目无 auth
       * 声明则不画。qrcode_poll 一族已随官方源下线（后端归 None），不再画扫码徽标。 */
      var badges = '';
      var ak = canonicalAuthKind(it.auth_kind);
      if (ak === 'oauth') {
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
       * 不会把空值直接提交给后端。
       *
       * 已安装条目（marketId 命中 installed 索引）：+ 号换成对勾 disabled 态
       * （title=已安装），卡片加 .mcp-market-card-installed 类与徽标（形态参考
       * 技能卡 .skill-card-installed）。整卡仍可点开详情弹窗查看/重复连接。 */
      var installed = isInstalled(it.id);
      var addLabel = installed ? m('installed_badge', '已安装') : m('connect', '连接');
      var addBtn = installed
        ? '<button type="button" class="mcp-market-card-add mcp-market-card-installed-check" disabled' +
          ' title="' + esc(addLabel) + '" aria-label="' + esc(addLabel) + '">' + CHECK_SVG + '</button>'
        : '<button type="button" class="mcp-market-card-add" data-act="install" data-id="' + id +
          '" title="' + esc(addLabel) + '" aria-label="' + esc(addLabel) + '">' + PLUS_SVG + '</button>';
      if (installed) {
        badges += '<span class="mcp-market-badge mcp-market-installed-badge">' +
          esc(m('installed_badge', '已安装')) + '</span>';
      }
      return '' +
        '<div class="mcp-market-card' + (installed ? ' mcp-market-card-installed' : '') + '" data-id="' + id + '">' +
        '  <div class="mcp-market-card-top">' + logo +
        '    <div class="mcp-market-card-name">' + esc(pickText(it, 'name') || it.id) + '</div>' +
        '    ' + addBtn +
        '  </div>' +
        '  <div class="mcp-market-card-desc">' + esc(pickText(it, 'description')) + '</div>' +
        '  <div class="mcp-market-card-foot">' +
        '    <span class="mcp-market-meta">' + meta.join(' · ') + '</span>' + badges +
        '  </div>' +
        '</div>';
    }).join('');
  }

  /** 分页窗口按源：魔搭上游硬限制 page*pageSize≤100（钳制必须保留）；
   * 腾讯云（offset 换算跨上游页）与 Smithery（totalPages 250+）无窗口，
   * 以 total_count 驱动。本页不满一律视为无下一页。 */
  function hasMorePages() {
    if (!(state.items.length > 0 && state.items.length >= state.page * state.pageSize)) return false;
    if (state.source === 'modelscope') return state.page * state.pageSize < 100;
    return !state.total || state.items.length < state.total;
  }

  function syncChrome() {
    if (!state.root) return;
    /* 总数经宿主统一登记（app-skills.js _mcpMarketReportTotal）：tab 重建时
     * 徽标 span 是新节点，宿主记住最近值即时回填，不再闪空。独立嵌入
     * （无宿主回调）时退回直写。 */
    if (typeof window._mcpMarketReportTotal === 'function') {
      window._mcpMarketReportTotal(state.total);
    } else {
      var totalEl = document.getElementById('mcpMarketTotal');
      if (totalEl) totalEl.textContent = state.total ? String(state.total) : '';
    }
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
   * 2026-11：「精选/已托管」勾选与「目录源 tabs」均已退役 —— 广场只剩魔搭
   * 一个目录源，头部只保留分类 chips。 */
  var boundHead = false;
  function bindHeadOnce() {
    if (boundHead) return;
    var bar = document.getElementById('mcpMarketCatBar');
    if (!bar) return;
    boundHead = true;
    bar.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.skills-category-chip') : null;
      if (chip) setCategory(chip.getAttribute('data-cat') || '');
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
    p.set('source', state.source);
    if (state.search) p.set('search', state.search);
    p.set('page', String(nextPage));
    p.set('pageSize', String(state.pageSize));
    if (state.category) p.set('category', state.category);
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
  /** 拉取已落盘连接器名单，重建 marketId 索引。
   *  失败静默降级（索引清空 = 全部按未安装渲染），绝不让广场加载失败：
   *  已安装态是增强信息，不是广场可用性的前置条件。 */
  async function refreshInstalled() {
    try {
      var data = await api(API.installed);
      var list = Array.isArray(data) ? data : ((data && data.servers) || []);
      var idx = {};
      list.forEach(function (s) {
        if (s && s.marketId) idx[String(s.marketId)] = true;
      });
      state.installedIndex = idx;
    } catch (_) {
      state.installedIndex = {};
    }
  }

  function isInstalled(id) {
    return !!(id && state.installedIndex[String(id)]);
  }

  /** 分类表按源缓存（三源都是内核静态表，运行期不变）：切源不再每次
   * 多发一个分类请求。失败不入缓存（下次进源重试），也不阻塞列表首屏。 */
  var catCache = {};
  async function ensureCategories(src) {
    if (catCache[src]) { state.categories = catCache[src]; return; }
    try {
      var data = await api(API.categories + '?source=' + encodeURIComponent(src));
      var cats = Array.isArray(data) ? data : (data.categories || []);
      /* 过期响应丢弃：请求期间用户又切了源，旧源分类不得盖掉新源的表
       * （三源分类 key 语义完全不同，盖掉 = 点分类得到空列表）。 */
      if (state.source !== src) return;
      catCache[src] = cats;
      state.categories = cats;
    } catch (e) {
      console.warn('[mcp-market] categories failed: ' + e.message);
      if (state.source === src && !state.categories.length) {
        state.categories = [{ key: '', nameZh: '全部', name: 'All' }];
      }
    }
  }

  /** 切换目录源（app-skills.js 二级导航分派）。重置筛选代际：分类/搜索/页码
   * 全部归零 —— 三个源的分类 key 语义完全不同（魔搭 kebab key / 腾讯数字 id /
   * Smithery 无分类），沿用旧 category 会得到空列表。搜索词也清空（各源检索
   * 能力不同：Smithery 是本地索引）。detailCache 不清（key=带前缀 id，跨源不撞）。
   *
   * ⚠ 先 load() 后补分类（2026-11 codereview）：旧实现 await loadCategories()
   * 再 load()，把列表首屏押在分类请求后面 —— 串行两跳；且 await 窗口里用户
   * 再切源/再进页会并发触发第二次 load()，旧源慢响应回来还会污染新源视图。
   * 现在列表立即发出（分类只是筛选增强），分类异步回填 + 代际校验。 */
  async function setSource(src) {
    src = String(src || 'modelscope');
    if (SOURCES.indexOf(src) < 0) src = 'modelscope';
    if (state.source === src) return;
    state.source = src;
    state.category = '';
    state.search = '';
    state.page = 1;
    state.items = [];
    state.total = 0;
    state.categories = [];
    state.detailId = null;
    state.loadError = false;
    var pending = load();
    ensureCategories(src).then(function () {
      if (state.source === src) { syncChrome(); refreshCatBar(); }
    });
    await pending;
  }

  /** 分类异步回填后只重画 chips（不整壳重建：列表/滚动位置保持）。 */
  function refreshCatBar() {
    var bar = document.getElementById('mcpMarketCatBar');
    if (!bar) return;
    bar.innerHTML = state.categories.map(function (c) {
      var name = (window.GourdI18n && /zh/i.test(window.GourdI18n.getLocale ? window.GourdI18n.getLocale() : '')) ? c.nameZh : (c.name || c.nameZh);
      return '<button type="button" class="skills-category-chip' + (state.category === c.key ? ' active' : '') +
        '" data-cat="' + esc(c.key) + '">' + esc(name || c.nameZh) + '</button>';
    }).join('');
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
    /* 已安装索引与目录并行拉取（不阻塞目录首屏）；返回后只重画卡片区，
     * 不整壳重建。失败静默降级为全部未安装（refreshInstalled 内兜底）。 */
    refreshInstalled().then(function () {
      if (seq === state.loadSeq) cards();
    });
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
   *   hero —— 居中大 logo +「连接 {名称}」标题 + 认证/托管徽标 + 描述（纯信息区）；
   *   body —— 对接配置表单（env_schema，仅在字段可被持久化时出现）+ readme 全文；
   *   foot —— 取消 + 保存并连接（有配置表单时）/ 取消 + 连接（无表单时）。
   * ⚠ hero 里【不得】再放「连接」按钮：foot 已有唯一主操作（data-confirm），
   *   双按钮同语义重复（2026-11 用户报障「连接按钮重复了」），且 hero 按钮
   *   不感知表单文案（有必填 env 时仍写「连接」，与 foot「保存并连接」割裂）。
   *   回归护栏见 mcp-market-contract.test.js ㉑(e)。
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
     * 「精选」「已托管」概念已按用户拍板整体移除：魔搭 hosted 专属 URL
     * 未实现，展示「已托管」只会误导用户勾了连不上。 */
    var badges = '';
    /* 已安装徽标：弹窗顶部提示该条目已落盘。主按钮保持「连接」仍可点——
     * 重复安装因后端重名自动加后缀会装成 name-2，是可接受行为，不禁止。 */
    if (isInstalled(id)) {
      badges += '<span class="mcp-market-badge mcp-market-installed-badge">' +
        esc(m('installed_badge', '已安装')) + '</span>';
    }
    if (d && d.is_verified) badges += '<span class="mcp-market-verified" title="verified">✓ ' + esc(m('verified', '已认证')) + '</span>';
    /* 授权形态徽标：从 server_config 的 auth 声明读 authType（非密钥），
     * 让用户连接前就知道要做什么：oauth=浏览器登录/扫码，token=静态 Token。
     * qrcode_poll 一族已随官方源下线（后端归 None），不再画扫码徽标。 */
    var authKind = canonicalAuthKind(detailAuthKind(d));
    if (authKind === 'oauth') badges += '<span class="mcp-market-badge-oauth">' + esc(m('oauth_badge', '登录/扫码授权')) + '</span>';
    else if (authKind === 'token') badges += '<span class="mcp-market-token-badge">' + esc(m('token_badge', 'Token')) + '</span>';
    /* 详情弹窗默认图标与卡片同款：名字前两字母做底，代理 <img> 叠上面，
     * 失败自毁露出字母底（旧版 img 失败后整块消失，无图条目只有单字母）。 */
    var heroName = pickText(d, 'name') || id || 'M';
    var heroLetter = esc(String(heroName).substring(0, 2).toUpperCase());
    var logo = '<div class="mcp-market-hero-logo mcp-market-logo-ph"><span>' + heroLetter + '</span>' +
      ((d && d.logo_url)
        ? '<img src="' + esc(proxyIcon(d.logo_url)) + '" alt="" onerror="this.remove()">'
        : '') +
      '</div>';
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
    if (modal) modal.querySelectorAll('[data-confirm],[data-retry]').forEach(function (b) {
      b.classList.toggle('installing', !!on); b.disabled = !!on;
    });
  }

  async function install(id, env) {
    if (!id) return;
    if (installing[id]) return;            // 在途：连点直接忽略
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

  /** 原安装请求体（env_schema 输入与提示完全保持原样）。
   *
   *  修1：后端 install 现在透传 connectErrors（mcp_server_add 返回 code 200
   *  但 connected:false + connectError 的「已落盘但连不上」名单）。非空时
   *  必须弹 warning「已保存，但连接失败」，绝不弹绿色「已安装」假成功；
   *  全部连接成功才走原有 success toast。installed 语义仍是「已落盘名单」。 */
  async function submitInstall(id, env) {
    var data = await api(API.install, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, env: env }),
    });
    var names = (data && data.installed) || [];
    var errs = (data && data.connectErrors) || [];
    /* 缺运行时（后端 MissingProgram → connectErrors[].runtime）：不算报错，
     * 不弹错误 toast —— 直接进「正在下载运行环境」进度弹窗自动代装，装好
     * 自动重连，全部成功才报「安装完成」（offerRuntimeInstall 内负责成功
     * toast）。其余失败（网络/凭据/不可代装命令）如实 warning，绝不假成功。 */
    rtState.rounds = 0;                     // 新一轮安装：续装轮次清零
    var rtEntries = errs.filter(function (e) { return e && e.runtime && e.runtimeInstallable !== false; });
    var hardErrs = errs.filter(function (e) { return rtEntries.indexOf(e) < 0; });
    if (hardErrs.length) {
      var msg = hardErrs.map(function (e) {
        return (e && e.name ? e.name + ': ' : '') + ((e && e.error) || '');
      }).join('; ');
      toast(tMsg('saved_connect_failed', '已保存，但连接失败：{msg}', msg), 'warning');
    }
    if (rtEntries.length) {
      await offerRuntimeInstall(rtEntries);
    } else if (!errs.length) {
      toast(names.length
        ? tMsg('installed_names', '已安装：{msg}', names.join(', '))
        : m('installed', '已安装'), 'success');
    }
    closeDetail();
    /* 修4：安装落盘后刷新 installed 索引并只重画卡片区（不整页 reload）。
     * 连接失败的条目也已落盘，同样按已安装渲染（口径 = 已落盘）。 */
    refreshInstalled().then(function () { cards(); });
    if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
    if (window._skills && window._skills.refresh) window._skills.refresh();
    return data;
  }

  // ─── 运行时（uv/Node）自动代装 ───────────────────────────────────────────
  //
  // 2026-11 报障「blender: 检测失败: program not found」：目录条目大量依赖
  // uvx/npx 启动器，本机没装对应运行时则 spawn 必败。用户二次拍板：
  // 「不要提示报错，缺少环境就静默安装，只是交互上提示用户在下载运行环境，
  //   不要再让用户确认点击；运行环境安装完成，整个连接器才安装完成」。链路：
  //   install 响应 connectErrors[].runtime（后端 MissingProgram 结构化透传）
  //   → 进度弹窗立即 POST runtime/install（零确认点击）→ status 轮询进度条
  //   → done 后自动 toggle 重连已落盘条目 → 全部重连成功才报「安装完成」；
  //   重连仍缺别的运行时则自动续装（有轮次上限防死循环）。
  //   失败才显示错误 + 重试/关闭按钮。
  // 弹窗骨架复用 mcp-auth.css（认证弹窗同源视觉），不新建样式文件。

  /* gen = 弹窗代际号：每次开新弹窗 +1。在途的轮询/重连回调只有仍持有当前
   * 代际才允许写 UI / 续装 / finish——否则关闭旧弹窗后立刻开新弹窗（或续装
   * 换运行时）时，旧回调会把错误写进新弹窗、甚至用旧名单误报「已安装」。 */
  var rtState = { gen: 0, pollTimer: null, cancelled: false, rounds: 0 };

  function rtName(id) {
    return id === 'uv' ? 'uv (astral)' : 'Node.js';
  }

  function closeRuntimeDialog() {
    if (rtState.pollTimer) { clearTimeout(rtState.pollTimer); rtState.pollTimer = null; }
    var el = document.getElementById('mcpRuntimeOverlay');
    if (el) el.remove();
  }

  /** 命令级入口（手动添加/编辑表单用）：check 探测命令 → 可代装则直接
   *  进自动代装进度弹窗（无需用户确认）。command 如 "uvx"；
   *  names = 装好后要重连的已落盘连接器名。 */
  async function offerRuntimeForCommand(command, names) {
    if (!command) return false;
    var st;
    try {
      st = await api(API.runtimeCheck + '?command=' + encodeURIComponent(command));
    } catch (_) { return false; }
    if (!st || st.resolved || !st.runtime || !st.installable) return false;
    rtState.rounds = 0;                     // 新一轮安装：续装轮次清零
    return offerRuntimeInstall([{ name: (names && names[0]) || '', runtime: st.runtime, runtimeInstallable: true }].concat(
      (names || []).slice(1).map(function (n) { return { name: n, runtime: st.runtime, runtimeInstallable: true }; })));
  }

  /** 缺运行时自动代装。entries = connectErrors 里带 runtime 字段的条目；
   *  carryFailed = 上一轮续装携带的硬失败（本弹窗最终失败时必须一并展示，
   *  成功时也必须如实提示这些条目没连上，绝不静默吞掉）。
   *  弹窗出现即自动开始下载（零确认点击），只展示「正在下载运行环境」进度。
   *  resolve(true) = 运行时装好且全部重连成功（此刻才报「安装完成」）；
   *  resolve(false) = 下载失败 / 重连仍失败 / 用户中途关闭。 */
  function offerRuntimeInstall(entries, carryFailed, carryOk) {
    var pick = null;
    for (var i = 0; i < entries.length; i++) {
      if (entries[i] && entries[i].runtime && entries[i].runtimeInstallable !== false) { pick = entries[i]; break; }
    }
    if (!pick) return Promise.resolve(false);
    var runtime = pick.runtime;
    var names = entries.filter(function (e) { return e && e.runtime === runtime; })
      .map(function (e) { return e.name; });
    closeRuntimeDialog();
    var gen = ++rtState.gen;                // 新弹窗代际：旧弹窗在途回调即刻失效
    /* 同一弹窗内混合运行时（如 uvx 条目 + npx 条目同装）：先装 pick 的运行时、
     * 只重连它的条目；其余运行时的条目并入续装名单，装完接着装下一个——
     * 否则它们被静默丢弃，永远停在「已落盘未连接」。 */
    var restEntries = entries.filter(function (e) {
      return e && e.runtime && e.runtimeInstallable !== false && e.runtime !== runtime;
    });
    var overlay = document.createElement('div');
    overlay.className = 'mcp-auth-overlay';
    overlay.id = 'mcpRuntimeOverlay';
    overlay.innerHTML =
      '<div class="mcp-auth-dialog" role="dialog" aria-modal="true">' +
      '  <div class="mcp-auth-header"><span class="mcp-auth-title">' +
      esc(m('rt_title', '正在安装运行环境')) + '</span></div>' +
      '  <div class="mcp-auth-body">' +
      '    <div class="mcp-auth-help-text">' +
      esc(tMsg('rt_need', '连接器需要 {msg} 运行环境，正在自动下载安装…', rtName(runtime))) + '</div>' +
      '    <div class="mcp-auth-help-text">' +
      esc(m('rt_source', '正在从官方渠道下载并安装到应用目录（不修改系统 PATH，无需管理员权限）。')) + '</div>' +
      '    <div class="mcp-auth-runtime-progress" id="mcpRuntimeProgress">' +
      '      <div class="mcp-auth-runtime-bar"><div class="mcp-auth-runtime-bar-fill" id="mcpRuntimeBarFill"></div></div>' +
      '      <div class="mcp-auth-help-text" id="mcpRuntimePhase">' +
      esc(tMsg('rt_downloading', '正在下载运行环境… {msg}', '0%')) + '</div>' +
      '    </div>' +
      '    <div class="mcp-auth-error" id="mcpRuntimeError" style="display:none"></div>' +
      '  </div>' +
      '  <div class="mcp-auth-footer" id="mcpRuntimeFooter" style="display:none">' +
      '    <button type="button" class="mcp-auth-btn mcp-auth-btn-ghost" data-rt-close>' +
      esc(m('cancel', '取消')) + '</button>' +
      '    <button type="button" class="mcp-auth-btn mcp-auth-btn-primary" id="mcpRuntimeRetry">' +
      esc(m('retry', '重试')) + '</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(overlay);
    return new Promise(function (resolve) {
      var settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        closeRuntimeDialog();
        resolve(ok);
      }
      rtState.cancelled = false;
      overlay.querySelectorAll('[data-rt-close]').forEach(function (b) {
        b.addEventListener('click', function () { rtState.cancelled = true; finish(false); });
      });
      /* 失败后才出现的「重试」：重新走一遍自动安装（不是安装前的确认门）。
       * gen 失效（弹窗已被新安装取代）后不再响应，避免旧弹窗幽灵重连。 */
      overlay.querySelector('#mcpRuntimeRetry').addEventListener('click', function () {
        if (gen !== rtState.gen) return;
        rtState.cancelled = false;
        overlay.querySelector('#mcpRuntimeFooter').style.display = 'none';
        overlay.querySelector('#mcpRuntimeError').style.display = 'none';
        overlay.querySelector('#mcpRuntimeProgress').style.display = '';
        overlay.querySelector('#mcpRuntimeBarFill').style.width = '0%';
        startRuntimeInstall(runtime, names, restEntries, carryFailed || [], carryOk || [], gen, overlay, finish);
      });
      /* 用户拍板：不要确认点击 —— 弹窗挂载即自动开始下载安装。 */
      startRuntimeInstall(runtime, names, restEntries, carryFailed || [], carryOk || [], gen, overlay, finish);
    });
  }

  async function startRuntimeInstall(runtime, names, restEntries, carryFailed, carryOk, gen, overlay, finish) {
    if (gen !== rtState.gen) return;
    var errBox = overlay.querySelector('#mcpRuntimeError');
    var phaseEl = overlay.querySelector('#mcpRuntimePhase');
    var fill = overlay.querySelector('#mcpRuntimeBarFill');
    /* alive：本弹窗仍是当前弹窗且未被取消。所有 await 之后都必须重查——
     * 用户关闭 / 续装换弹窗发生在 await 期间时，旧回调不得再写 UI 或续装。
     * 判据用节点身份（=== 当前 overlay）而非仅存在性：换弹窗后旧节点已
     * remove，但新节点同 id 存在，只查存在性会把旧回调写进新弹窗。 */
    function alive() {
      return !rtState.cancelled && gen === rtState.gen
        && document.getElementById('mcpRuntimeOverlay') === overlay;
    }
    function showErr(msg) {
      if (!alive()) return;
      errBox.textContent = msg;
      errBox.style.display = '';
      overlay.querySelector('#mcpRuntimeProgress').style.display = 'none';
      overlay.querySelector('#mcpRuntimeFooter').style.display = '';
    }
    try {
      await api(API.runtimeInstall, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: runtime }),
      });
    } catch (e) {
      showErr(tMsg('rt_failed', '运行环境安装失败：{msg}', e.message));
      return;
    }
    if (!alive()) return;
    function poll() {
      rtState.pollTimer = setTimeout(async function () {
        if (!alive()) return;
        var st;
        try {
          st = await api(API.runtimeStatus + '?runtime=' + encodeURIComponent(runtime));
        } catch (e) {
          showErr(tMsg('rt_failed', '运行环境安装失败：{msg}', e.message));
          return;
        }
        if (!alive()) return;               // 弹窗已关闭 / 已被新安装取代
        if (st.phase === 'downloading') {
          var pct = st.total > 0 ? Math.min(99, Math.round(st.received * 100 / st.total)) : 0;
          fill.style.width = pct + '%';
          phaseEl.textContent = tMsg('rt_downloading', '正在下载运行环境… {msg}',
            st.total > 0 ? pct + '%' : Math.round(st.received / 1024) + ' KB');
          poll();
        } else if (st.phase === 'extracting') {
          fill.style.width = '100%';
          phaseEl.textContent = m('rt_extracting', '正在解压安装…');
          poll();
        } else if (st.phase === 'done') {
          fill.style.width = '100%';
          phaseEl.textContent = m('rt_done', '运行环境安装完成，正在连接连接器…');
          /* 运行环境装好 ≠ 连接器装好：必须重连并核实结果，全部成功
           * 才报「安装完成」；仍缺别的运行时（含同批混合运行时的其余条目）
           * 则自动续装（上限 3 轮防死循环）。 */
          var results = await reconnectServers(names);
          if (!alive()) return;
          var again = results.filter(function (r) { return r && r.runtime && r.runtimeInstallable !== false; })
            .concat(restEntries);
          /* 硬失败 = 本轮非运行时失败 + 上一轮续装携带的失败（绝不吞掉）。 */
          var failed = results.filter(function (r) { return r && !r.ok && again.indexOf(r) < 0; })
            .concat(carryFailed || []);
          if (again.length && rtState.rounds < 3) {
            rtState.rounds += 1;
            /* 续装换弹窗会 ++gen，旧回调自此失效；硬失败带进新弹窗一并如实
             * 展示（否则 A 失败 + B 续装成功会把 A 的失败静默吞掉）；本轮
             * 已成功的名单同样携带，最终成功 toast 涵盖全部装好的条目。 */
            var okSoFar = results.filter(function (r) { return r && r.ok; })
              .map(function (r) { return r.name; }).concat(carryOk || []);
            var next = await offerRuntimeInstall(again, failed, okSoFar);
            finish(next);
            return;
          }
          if (!failed.length && !again.length) {
            /* 成功名单 = 本轮重连成功 + 前几轮已成功（续装携带）——混合
             * 运行时批次分轮完成，只报最后一轮会把先装好的条目漏掉。 */
            var okNames = results.filter(function (r) { return r && r.ok; })
              .map(function (r) { return r.name; }).concat(carryOk || []);
            toast(tMsg('installed_names', '已安装：{msg}', okNames.join(', ')), 'success');
            finish(true);
          } else {
            /* again 非空但轮次用尽：这些条目仍缺运行时，同样如实计入失败。 */
            var allFailed = failed.concat(again);
            var msg = allFailed.map(function (r) {
              return (r.name ? r.name + ': ' : '') + (r.error || '');
            }).join('; ') || tMsg('rt_conn_failed', '运行环境已安装，但连接器仍未连接成功：{msg}', names.join(', '));
            showErr(tMsg('rt_conn_failed', '运行环境已安装，但连接器仍未连接成功：{msg}', msg));
          }
        } else if (st.phase === 'error') {
          showErr(tMsg('rt_failed', '运行环境安装失败：{msg}', st.error || ''));
        } else {
          poll();
        }
      }, 600);
    }
    poll();
  }

  /** 代装完成后重连已落盘条目：toggle off→on 走后端 sync_engine 热插拔，
   *  与手动开关完全同链路（不新增重连端点）。返回逐条结果
   *  {name, ok, error, runtime, runtimeInstallable}——调用方据此判定
   *  「整个连接器是否安装完成」，不再失败静默。 */
  async function reconnectServers(names) {
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var r = { name: names[i], ok: false, error: '' };
      try {
        await api('/web/settings/mcp/servers/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: names[i], enabled: false }),
        });
        var resp = await api('/web/settings/mcp/servers/toggle', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: names[i], enabled: true }),
        });
        r.ok = !!(resp && resp.connected !== false);
        if (!r.ok) {
          r.error = resp.connectError || resp.message || '';
          /* 重连仍缺运行时（后端 mcp_saved_outcome 透传 missingCommand）：
           * 查 check 拿结构化 runtime，交给上层自动续装。 */
          if (resp.missingCommand) {
            var st = await api(API.runtimeCheck + '?command=' + encodeURIComponent(resp.missingCommand)).catch(function () { return null; });
            if (st && st.runtime && st.installable) { r.runtime = st.runtime; r.runtimeInstallable = true; }
          }
        }
      } catch (e) { r.error = (e && e.message) || ''; }
      out.push(r);
    }
    if (window._settingsMcp && window._settingsMcp.load) window._settingsMcp.load();
    refreshInstalled().then(function () { cards(); });
    return out;
  }

  // ─── 对外 ────────────────────────────────────────────────────────────────
  window._mcpMarket = {
    /* 只登记宿主节点，不发请求：applyConnView 每次显隐都会调它；
     * 首次挂载的补载统一由 app-skills.js 的「grid 为空才 load」分支负责，
     * 加载入口唯一，不存在 setHost 与显式 load() 的双请求路径。 */
    setHost: function (selector) {
      state.root = typeof selector === 'string' ? document.querySelector(selector) : selector;
    },
    load: async function () {
      if (!state.root) return;
      /* 列表立即发出；分类缺失时异步回填（不阻塞首屏，见 setSource 注释）。 */
      var src = state.source;
      if (!state.categories.length && !catCache[src]) {
        ensureCategories(src).then(function () {
          if (state.source === src) { syncChrome(); refreshCatBar(); }
        });
      }
      await load();
    },
    search: function (kw) { state.search = kw || ''; state.page = 1; return load(); },
    /* 源切换（app-skills.js 二级导航「魔搭/腾讯云/Smithery」分派）。 */
    setSource: setSource,
    getSource: function () { return state.source; },
    sources: SOURCES.slice(),
    /* 只重置查询词、不发请求：主 tab / 二级视图切换时用来作废幽灵过滤，
     * 真正的重查由切换流程里那次 load() 统一发出（避免重复请求）。 */
    clearSearch: function () { state.search = ''; state.page = 1; },
    showDetail: showDetail,
    install: install,
    /* 手动添加/编辑表单的缺运行时自动代装（app-settings-mcp.js doSave 失败分支）。 */
    offerRuntime: offerRuntimeForCommand,
    refresh: function () { return load(); },
    /* 无限滚动对外面：技能页滚动分派与「没有更多」判定用。 */
    hasMore: function () { return hasMorePages(); },
    loadMore: loadMore,
  };

  // Escape 关闭弹窗（与技能详情弹窗同体验）。持久节点一次性绑定，不随 render 累积。
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
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
  });
})();
