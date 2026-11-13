/* =============================================================================
 * app-mcp-market.js — 「连接器」页的魔搭 ModelScope MCP 广场目录
 *
 * 用户拍板：只接魔搭一个目录源（和技能市场一样），不做自定义源 / 多源；
 * 同时保留手动添加 MCP 的入口（由 app-skills.js 复用 #mcpAddBtn）。
 *
 * 后端：GET  /web/settings/mcp/market/servers?search=&page=&pageSize=&category=&hosted=
 *       GET  /web/settings/mcp/market/detail?id=
 *       GET  /web/settings/mcp/market/categories
 *       POST /web/settings/mcp/market/install  {id, env}
 *
 * 不硬编码任何魔搭 Token；列表/详情匿名可用，Hosted 专属 URL 本轮不实现。
 * ========================================================================== */
(function () {
  'use strict';

  var API = {
    servers: '/web/settings/mcp/market/servers',
    detail: '/web/settings/mcp/market/detail',
    categories: '/web/settings/mcp/market/categories',
    install: '/web/settings/mcp/market/install',
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
    hosted: false,
    page: 1,
    pageSize: 20,
    total: 0,
    items: [],
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
    if (state.hosted) p.set('hosted', '1');
    return p.toString();
  }

  // ─── 渲染 ────────────────────────────────────────────────────────────────
  function shell() {
    var cats = state.categories.map(function (c) {
      var name = (window.GourdI18n && /zh/i.test(window.GourdI18n.getLocale ? window.GourdI18n.getLocale() : '')) ? c.nameZh : (c.name || c.nameZh);
      return '<button type="button" class="mcp-market-chip' + (state.category === c.key ? ' active' : '') +
        '" data-cat="' + esc(c.key) + '">' + esc(name || c.nameZh) + '</button>';
    }).join('');
    return '' +
      '<div class="mcp-market">' +
      '  <div class="mcp-market-head">' +
      '    <div class="mcp-market-title">' + esc(m('title', 'MCP 服务市场')) +
      '      <span class="mcp-market-source">ModelScope</span></div>' +
      '    <div class="mcp-market-total">' + (state.total ? esc(String(state.total)) : '') + '</div>' +
      '  </div>' +
      '  <div class="mcp-market-controls">' +
      '    <input type="text" id="mcpMarketSearch" class="mcp-market-search" placeholder="' +
      esc(m('search_placeholder', '搜索 MCP 服务')) + '" value="' + esc(state.search) + '">' +
      '    <label class="mcp-market-hosted"><input type="checkbox" id="mcpMarketHosted"' +
      (state.hosted ? ' checked' : '') + '> ' + esc(m('hosted', '已托管')) + '</label>' +
      '  </div>' +
      '  <div class="mcp-market-cats">' + cats + '</div>' +
      '  <div id="mcpMarketGrid" class="mcp-market-grid"></div>' +
      '  <div class="mcp-market-pager">' +
      '    <button type="button" id="mcpMarketPrev"' + (state.page <= 1 ? ' disabled' : '') + '>‹</button>' +
      '    <span id="mcpMarketPage">' + state.page + '</span>' +
      '    <button type="button" id="mcpMarketNext">›</button>' +
      '  </div>' +
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
       *   view_count, locales, categories
       * **不含** is_hosted / is_verified —— 那两个字段只在详情接口里有。
       * 所以卡片不再画这两个 badge（否则永远不显示，是死代码），改画真实存在的
       * categories；「已托管」状态只在用户勾选筛选时才有意义，此时整页都是 hosted。
       * 认证标记移到详情弹窗显示（那里有 is_verified）。 */
      var meta = [];
      if (Array.isArray(it.categories) && it.categories.length) meta.push(esc(catName(it.categories[0])));
      if (it.view_count != null) meta.push(esc(shortNum(it.view_count)));
      /* 卡片安装入口与技能卡**同形态**（用户拍板：「和技能安装样式保持一致」）。
       * 技能卡是右上角一个 26px 的 `+` 号图标按钮（.skill-card-add，skills.css:196），
       * 不是文字按钮；此前 MCP 卡放了「详情 / 连接」两个文字按钮，与同页技能卡
       * 形态割裂，且「详情」与「点整卡」语义重复（整卡可点开弹窗）。
       * 现统一为：整卡可点开连接弹窗 + 右上角 `+` 号一键连接（语义等同技能安装）。
       * 图标 SVG 与 skills 的 .skill-card-add 完全一致（同 24 viewBox、同 stroke）。
       *
       * `+` 按钮走 install(id)（无 env）：有必填 env 时 install 会自动转弹窗补填，
       * 不会把空值直接提交给后端。 */
      return '' +
        '<div class="mcp-market-card" data-id="' + id + '">' +
        '  <div class="mcp-market-card-top">' + logo +
        '    <div class="mcp-market-card-name">' + esc(pickText(it, 'name') || it.id) + '</div>' +
        '    <button type="button" class="mcp-market-card-add" data-act="install" data-id="' + id +
        '" title="' + esc(m('connect', '连接')) + '" aria-label="' + esc(m('connect', '连接')) + '">' + PLUS_SVG + '</button>' +
        '  </div>' +
        '  <div class="mcp-market-card-desc">' + esc(pickText(it, 'description')) + '</div>' +
        '  <div class="mcp-market-card-foot">' +
        '    <span class="mcp-market-meta">' + meta.join(' · ') + '</span>' +
        '  </div>' +
        '</div>';
    }).join('');
  }

  function syncChrome() {
    if (!state.root) return;
    var total = state.root.querySelector('.mcp-market-total');
    if (total) total.textContent = state.total ? String(state.total) : '';
    var pageEl = document.getElementById('mcpMarketPage');
    if (pageEl) pageEl.textContent = String(state.page);
    var prev = document.getElementById('mcpMarketPrev');
    if (prev) prev.disabled = state.page <= 1;
    var next = document.getElementById('mcpMarketNext');
    if (next) next.disabled = state.items.length < state.pageSize || (state.page * state.pageSize >= 100);
    state.root.querySelectorAll('.mcp-market-chip').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-cat') === state.category);
    });
  }

  function render() {
    if (!state.root) return;
    /* 重建前记下搜索框的焦点与光标位置。
     * shell() 把 #mcpMarketSearch 一起画出来，render() 又是整块 innerHTML 替换，
     * 输入框会被销毁重建 —— 防抖 350ms 一到就渲染，焦点当场掉到 body，
     * 用户接着打字完全没反应（必须重新点进输入框），光标位置也丢。
     * 所以渲染后要在同一 id 的新节点上恢复 focus + caret。 */
    var prevSearch = document.getElementById('mcpMarketSearch');
    var hadFocus = false;
    var caret = 0;
    if (prevSearch && document.activeElement === prevSearch) {
      hadFocus = true;
      caret = typeof prevSearch.selectionStart === 'number' ? prevSearch.selectionStart : 0;
    }
    state.root.innerHTML = shell();
    cards();
    syncChrome();
    bind();
    if (hadFocus) {
      var nextSearch = document.getElementById('mcpMarketSearch');
      if (nextSearch) {
        if (typeof nextSearch.focus === 'function') nextSearch.focus();
        try {
          if (typeof nextSearch.setSelectionRange === 'function') nextSearch.setSelectionRange(caret, caret);
        } catch (_) { /* 某些浏览器在 type 变化时抛错，忽略即可 */ }
      }
    }
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
    var search = document.getElementById('mcpMarketSearch');
    if (search) {
      var timer = null;
      search.addEventListener('input', function () {
        clearTimeout(timer);
        var v = search.value.trim();
        timer = setTimeout(function () { state.search = v; state.page = 1; load(); }, 350);
      });
    }
    var hosted = document.getElementById('mcpMarketHosted');
    if (hosted) hosted.addEventListener('change', function () {
      state.hosted = !!hosted.checked; state.page = 1; load();
    });
    root.querySelectorAll('.mcp-market-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.category = b.getAttribute('data-cat') || ''; state.page = 1; load();
      });
    });
    var prev = document.getElementById('mcpMarketPrev');
    if (prev) prev.addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
    var next = document.getElementById('mcpMarketNext');
    if (next) next.addEventListener('click', function () { state.page++; load(); });
  }

  // ─── 数据 ────────────────────────────────────────────────────────────────
  async function loadCategories() {
    try {
      var data = await api(API.categories);
      state.categories = Array.isArray(data) ? data : (data.categories || []);
    } catch (e) {
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
      toast(tMsg('load_failed', '魔搭 MCP 目录加载失败：{msg}', e.message), 'error');
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
    /* 详情接口确实返回 is_verified / is_hosted（列表接口不返回），所以认证与托管
     * 标识放在弹窗里显示，而不是放在卡片上当永远不亮的死 badge。 */
    var badges = '';
    if (d && d.is_verified) badges += '<span class="mcp-market-verified" title="verified">✓ ' + esc(m('verified', '已认证')) + '</span>';
    if (d && d.is_hosted) badges += '<span class="mcp-market-hosted-badge">' + esc(m('hosted', '已托管')) + '</span>';
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

  async function install(id, env) {
    if (!id) return;
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
    } catch (e) {
      toast(tMsg('install_failed', '安装失败：{msg}', e.message), 'error');
    }
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
    showDetail: showDetail,
    install: install,
    refresh: function () { return load(); },
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
