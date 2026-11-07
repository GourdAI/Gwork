/* GWork 移动端主逻辑 —— 布局对照 9 张参考截图 74–82，品牌为 GWork 自有商标
 * 设计要点：
 *  - 无启动配对门禁：未连接内核也能完整浏览 4 个 Tab（D3）
 *  - 主题默认「系统」，浅色为默认观感，三态可切换（D1）
 *  - 4 Tab 固定底部、页面铺满视口（D2/D4）
 *  - 4 个交互面板：抽屉 / 选择设备 / ＋扩展 / 选择模型（D9）
 *  - 选中 Tab 使用实心图标变体（图 75/77/80/81）
 *  - 全部动作通过统一 invoke() 分发，dispatch 与真实点击逻辑等价
 */
(function (global) {
  'use strict';

  var D = global.GWorkData;
  var I = global.GWorkIcons;
  var STORE_KEY = 'gwork.mobile.state.v1';

  function icon(name, cls) {
    var html = I.get(name);
    if (cls && cls !== 'icon') {
      html = html.replace('class="icon"', 'class="icon ' + cls + '"');
    }
    return html;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var DEFAULT_STATE = {
    tab: 'tasks',
    theme: D.DEFAULT_THEME,
    suggestionPage: 0,
    composerFocused: false,
    composerText: '',
    modelId: 'hy3',
    deviceId: 'cloud',
    loopTab: 'tasks',
    haptics: true,
    panel: null,
    lastSent: ''
  };

  function loadState() {
    var state = Object.assign({}, DEFAULT_STATE);
    try {
      var raw = global.localStorage && localStorage.getItem(STORE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          Object.keys(DEFAULT_STATE).forEach(function (k) {
            if (Object.prototype.hasOwnProperty.call(parsed, k)) state[k] = parsed[k];
          });
        }
      }
    } catch (e) { /* 损坏的存档一律回退默认 */ }

    // 逐字段规范化：任何脏值都不能让 render 抛错/白屏。
    if (!D.TABS.some(function (t) { return t.id === state.tab; })) state.tab = 'tasks';
    if (D.THEMES.indexOf(state.theme) === -1) state.theme = D.DEFAULT_THEME;
    if (!D.MODELS.some(function (m) { return m.id === state.modelId; })) state.modelId = 'hy3';
    if (!D.DEVICES.some(function (d) { return d.id === state.deviceId; })) state.deviceId = 'cloud';
    // H2：suggestionPage 必须是合法整数下标。null / 小数 / 字符串 / NaN 都会让
    // SUGGESTIONS[page] 变成 undefined，随后 .map 抛错直到整页白屏。
    if (!Number.isInteger(state.suggestionPage) ||
        state.suggestionPage < 0 || state.suggestionPage >= D.SUGGESTIONS.length) {
      state.suggestionPage = 0;
    }
    if (['tasks', 'results'].indexOf(state.loopTab) === -1) state.loopTab = 'tasks';
    // L3：面板 / 输入焦点是瞬时 UI 态，绝不从存档恢复。重载必须回到干净主界面，
    // 否则残留 panel 会自开抽屉、composerFocused 会在移动端冷启动自动拉起软键盘。
    state.panel = null;
    state.composerFocused = false;
    state.haptics = state.haptics === true;
    // 文本字段强制为字符串：脏数据（对象/数字）会让 .trim() 抛错白屏
    state.composerText = typeof state.composerText === 'string' ? state.composerText : '';
    state.lastSent = typeof state.lastSent === 'string' ? state.lastSent : '';
    return state;
  }

  function saveState() {
    try {
      // 面板与焦点不持久化：重新打开应用应回到干净主界面
      var copy = Object.assign({}, state);
      copy.panel = null;
      copy.composerFocused = false;
      if (global.localStorage) localStorage.setItem(STORE_KEY, JSON.stringify(copy));
    } catch (e) { /* 隐私模式/存储不可用：内存状态仍可用 */ }
  }

  var state = loadState();
  var els = {};
  var lastAction = null;   // 宿主动作记录，供集成方断言「按钮不是死的」
  var lastTrigger = null;  // 面板焦点归还用

  function currentDevice() {
    return D.DEVICES.filter(function (d) { return d.id === state.deviceId; })[0] || D.DEVICES[0];
  }
  // 首页副行：云端显示「云电脑」（图 75），选中离线设备时显示设备名（图 74）
  function homeDeviceLabel() {
    var d = currentDevice();
    return d.id === 'cloud' ? D.BRAND.device : d.label;
  }

  // ---------- 渲染：顶栏 ----------
  function renderHomeTopbar() {
    var dev = currentDevice();
    return '<div class="statusbar" aria-hidden="true"></div>' +
      '<header class="topbar">' +
        '<button class="round-btn" data-action="open-drawer" aria-label="打开云端任务抽屉">' + icon('menu') + '</button>' +
        '<div class="brand">' +
          '<div class="brand-row">' +
            '<img class="brand-logo" src="' + esc(D.BRAND.logo) + '" alt="GWork 商标" draggable="false">' +
            '<span class="brand-name">' + esc(D.BRAND.name) + '</span>' +
          '</div>' +
          '<button class="brand-sub" data-action="open-devices" aria-label="选择设备">' +
            icon(dev.icon) + '<span>' + esc(homeDeviceLabel()) + '</span>' + icon('chevRight', 'chev') +
          '</button>' +
        '</div>' +
      '</header>';
  }

  function renderCenterTopbar(title) {
    return '<div class="statusbar" aria-hidden="true"></div>' +
      '<header class="topbar topbar--center"><span class="topbar-title">' + esc(title) + '</span></header>';
  }

  function renderLoopTopbar() {
    var dev = currentDevice();
    return '<div class="statusbar" aria-hidden="true"></div>' +
      '<header class="topbar">' +
        '<button class="device-pill" data-action="open-devices" aria-label="选择设备">' +
          icon(dev.icon) +
          (dev.id !== 'cloud' ? '<span>' + esc(dev.label) + '</span>' : '') +
          icon('chevDown', 'chev') +
        '</button>' +
        '<div class="segment-tabs" role="tablist">' +
          '<button class="segment-tab' + (state.loopTab === 'tasks' ? ' is-active' : '') + '" data-action="loop-tab" data-tab="tasks" role="tab" aria-selected="' + (state.loopTab === 'tasks') + '">任务</button>' +
          '<button class="segment-tab' + (state.loopTab === 'results' ? ' is-active' : '') + '" data-action="loop-tab" data-tab="results" role="tab" aria-selected="' + (state.loopTab === 'results') + '">结果</button>' +
        '</div>' +
      '</header>';
  }

  // ---------- 渲染：页 1 任务 ----------
  function renderComposer() {
    var focused = state.composerFocused;
    var text = esc(state.composerText);
    var model = D.MODELS.filter(function (m) { return m.id === state.modelId; })[0] || D.MODELS[0];
    var ready = state.composerText.trim().length > 0;

    if (!focused) {
      // 不用 button 嵌套 button（非法 HTML 且内层无法键盘聚焦）：容器用 div，语音与 ＋ 各自独立 button
      return '<div class="composer">' +
        '<div class="composer-box composer-idle-box">' +
          '<button class="composer-idle-main" data-action="focus-composer">' +
            icon('voice') + '<span class="placeholder">发消息或按住说话...</span>' +
          '</button>' +
          '<button class="icon-btn" data-action="open-attach" aria-label="展开更多">' + icon('plus') + '</button>' +
        '</div>' +
      '</div>';
    }

    return '<div class="composer">' +
      '<div class="composer-box composer-focus">' +
        '<textarea id="composer-input" class="composer-input" rows="2" placeholder="发消息..." aria-label="消息输入">' + text + '</textarea>' +
        '<div class="composer-actions">' +
          '<button class="icon-btn" data-action="voice" aria-label="语音输入">' + icon('voice') + '</button>' +
          '<button class="model-chip" data-action="open-models" aria-label="选择模型">' +
            icon('hy') + '<span>' + esc(model.name) + '</span>' + icon('chevDown', 'chev') +
          '</button>' +
          '<span class="spacer"></span>' +
          '<button class="icon-btn" data-action="open-attach" aria-label="展开更多">' + icon('plus') + '</button>' +
          '<button class="send-btn' + (ready ? ' is-ready' : '') + '" data-action="send" ' +
            (ready ? '' : 'disabled aria-disabled="true" ') +
            'aria-label="发送' + (ready ? '' : '（请先输入内容）') + '">' + icon('send') + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderTasksPage() {
    // 双保险：即使 loadState 被绕过，也让 list 一定是数组
    var list = D.SUGGESTIONS[state.suggestionPage] || D.SUGGESTIONS[0];
    var suggestions = list.map(function (s) {
      return '<button class="suggestion" data-action="suggestion" data-label="' + esc(s.label) + '">' +
        icon(s.icon) + '<span>' + esc(s.label) + '</span></button>';
    }).join('');

    return renderHomeTopbar() +
      '<div class="page-body page-body--home' + (state.composerFocused ? ' is-focused' : '') + '">' +
        '<div class="hero">' +
'<img class="hero-robot" src="./assets/robot.png" alt="GWork 智能助手" draggable="false">' +
          '<h1 class="hero-title">' + esc(D.BRAND.welcome) + '</h1>' +
          '<div class="suggestions">' + suggestions + '</div>' +
          '<button class="refresh-btn" data-action="refresh-suggestions" aria-label="换一换建议">' +
            icon('refresh') + '<span>换一换</span></button>' +
        '</div>' +
      '</div>' +
      renderComposer();
  }

  // ---------- 渲染：页 2 定时任务 ----------
  function renderLoopPage() {
    return renderLoopTopbar() +
      '<div class="page-body">' +
        '<div class="empty-state">' +
          '<div class="empty-robot">' + icon('emptyRobot', 'icon-lg') + '</div>' +
          '<span class="empty-text">' + (state.loopTab === 'tasks' ? '暂无自动化任务' : '暂无任务结果') + '</span>' +
        '</div>' +
      '</div>' +
      '<button class="fab" data-action="new-loop" aria-label="新建定时任务">' + icon('plus') + '</button>';
  }

  // ---------- 渲染：页 3 发现 ----------
  function renderDiscoverPage() {
    var groups = D.DISCOVER_GROUPS.map(function (group) {
      var rows = group.map(function (row) {
        return '<button class="list-row" data-action="discover-row" data-id="' + esc(row.id) + '">' +
          icon(row.icon) + '<span class="row-label">' + esc(row.label) + '</span>' + icon('chevRight', 'chev') +
        '</button>';
      }).join('');
      return '<div class="card-group">' + rows + '</div>';
    }).join('');
    return renderCenterTopbar('发现') + '<div class="page-body">' + groups + '</div>';
  }

  // ---------- 渲染：页 4 我的 ----------
  function renderMinePage() {
    var themeButtons = D.THEMES.map(function (t) {
      return '<button class="' + (state.theme === t ? 'is-active' : '') + '" data-action="set-theme" data-theme="' + esc(t) + '" aria-pressed="' + (state.theme === t) + '">' + esc(D.THEME_LABELS[t]) + '</button>';
    }).join('');

    var rows = D.SETTINGS_ROWS.map(function (row) {
      var right = row.toggle
        ? '<button class="switch' + (state.haptics ? ' is-on' : '') + '" data-action="toggle-haptics" role="switch" aria-checked="' + state.haptics + '" aria-label="触感反馈"></button>'
        : (row.value ? '<span class="row-value">' + esc(row.value) + '</span>' : '') +
          (row.chevron ? icon('chevRight', 'chev') : '');
      return '<div class="list-row" data-row="' + esc(row.id) + '">' +
        '<span class="row-label">' + esc(row.label) + '</span>' + right + '</div>';
    }).join('');

    return renderCenterTopbar('我的') +
      '<div class="page-body">' +
        '<div class="card-group">' +
          '<button class="profile-row" data-action="profile" style="width:100%;text-align:left">' +
            '<span class="avatar">B</span><span class="profile-name">Blake</span>' + icon('chevRight', 'chev') +
          '</button>' +
          '<div class="profile-divider"></div>' +
          '<div class="plan-row">' + icon('flower') + '<span>体验版</span><span class="spacer"></span>' +
            '<button class="upgrade-btn" data-action="upgrade">升级套餐</button></div>' +
          '<button class="list-row" data-action="points" style="width:100%">' +
            '<span class="row-label">我的积分</span><span class="row-value">3363.38</span>' + icon('chevRight', 'chev') +
          '</button>' +
        '</div>' +
        '<div class="card-group">' +
          '<div class="list-row" data-row="theme"><span class="row-label">主题</span>' +
            '<div class="theme-segment" role="group" aria-label="主题">' + themeButtons + '</div></div>' +
          rows +
        '</div>' +
      '</div>';
  }

  var PAGE_RENDERERS = {
    tasks: renderTasksPage,
    loop: renderLoopPage,
    discover: renderDiscoverPage,
    mine: renderMinePage
  };

  // ---------- 渲染：Tab 栏（选中=实心图标，参考图 75/77/80/81） ----------
  function renderTabbar() {
    return D.TABS.map(function (t) {
      var active = state.tab === t.id;
      var iconName = active ? t.icon + 'Solid' : t.icon;
      var iconHtml = icon(iconName, active ? 'tab-solid' : '');
      return '<button class="tab-item' + (active ? ' is-active' : '') + '" data-action="switch-tab" data-tab="' + esc(t.id) + '" role="tab" aria-selected="' + active + '"' + (active ? ' aria-current="page"' : '') + '>' +
        iconHtml + '<span>' + esc(t.label) + '</span></button>';
    }).join('');
  }

  // ---------- 渲染：抽屉 ----------
  function renderDrawer() {
    var dev = currentDevice();
    return '<div class="drawer-head">' + icon(dev.icon) + '<span>' + esc(dev.label) + '</span>' + icon('chevDown', 'chev') + '</div>' +
      '<button class="new-task-btn" data-action="new-task">' + icon('newTask') + '<span>新建任务</span></button>' +
      '<div class="drawer-empty">暂无云端任务</div>';
  }

  // ---------- 渲染：sheets ----------
  function sheetHead(title, withHandle) {
    return (withHandle ? '<div class="sheet-handle" aria-hidden="true"></div>' : '') +
      '<div class="sheet-head"><span class="sheet-title">' + esc(title) + '</span>' +
      '<button class="sheet-close" data-action="close-panel" aria-label="关闭">' + icon('close') + '</button></div>';
  }

  function renderDevicesSheet() {
    var rows = D.DEVICES.map(function (d) {
      var selected = state.deviceId === d.id;
      return '<button class="device-row" data-action="select-device" data-id="' + esc(d.id) + '">' +
        icon(d.icon) + '<span class="row-label">' + esc(d.label) + '</span>' +
        (d.offline ? '<span class="offline">离线</span>' : '') +
        (selected ? '<span class="check">' + icon('check') + '</span>' : '') +
      '</button>';
    }).join('');
    return sheetHead('选择设备', false) + '<div class="sheet-body"><div class="device-card">' + rows + '</div></div>';
  }

  function renderAttachSheet() {
    var cells = D.QUICK_ACTIONS.map(function (a) {
      return '<button class="quick-cell" data-action="quick-action" data-id="' + esc(a.id) + '">' +
        icon(a.icon) + '<span>' + esc(a.label) + '</span></button>';
    }).join('');
    var rows = D.SHEET_LIST_ROWS.map(function (r) {
      return '<button class="sheet-list-row" data-action="sheet-row" data-id="' + esc(r.id) + '">' +
        icon(r.icon) + '<span class="row-label">' + esc(r.label) + '</span>' + icon('chevRight', 'chev') +
      '</button>';
    }).join('');
    return '<div class="sheet-handle" aria-hidden="true"></div>' +
      '<div class="sheet-body"><div class="quick-grid">' + cells + '</div>' + rows + '</div>';
  }

  function renderModelsSheet() {
    var rows = D.MODELS.map(function (m) {
      var selected = state.modelId === m.id;
      return '<button class="model-row" data-action="select-model" data-id="' + esc(m.id) + '">' +
        icon(m.icon) +
        '<span class="model-name">' + esc(m.name) + '</span>' +
        (m.free ? '<span class="free-tag">限时免费</span>' : '') +
        '<span class="model-ratio">' + esc(m.ratio) + '</span>' +
        '<span class="spacer"></span>' +
        (selected ? '<span class="check">' + icon('check') + '</span>' : '') +
      '</button>';
    }).join('');
    return sheetHead('选择模型', true) +
      '<div class="sheet-body">' + rows +
      '<div class="model-more">' + icon('chevDown') + '</div></div>';
  }

  var PANEL_RENDERERS = {
    drawer: renderDrawer,
    devices: renderDevicesSheet,
    attach: renderAttachSheet,
    models: renderModelsSheet
  };

  // ---------- 主渲染 ----------
  function render(opts) {
    opts = opts || {};
    // M1：重渲染前保存光标/选区，渲染后原样恢复。换一换、切主题、选模型等
    // 动作不再把光标强行推到末尾、也不再让软键盘闪烁。
    var caret = null;
    if (state.tab === 'tasks' && state.composerFocused && els.pageRoot) {
      var old = document.getElementById('composer-input');
      if (old) {
        try { caret = { s: old.selectionStart, e: old.selectionEnd }; } catch (e) { caret = null; }
      }
    }

    document.documentElement.setAttribute('data-theme', state.theme);
    var dark = state.theme === 'dark' ||
      (state.theme === 'system' && global.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', dark ? '#141416' : '#fafafa');
    // M6：color-scheme 同步，避免强制浅色时原生控件仍按系统深色渲染
    var metaScheme = document.querySelector('meta[name="color-scheme"]');
    if (metaScheme) metaScheme.setAttribute('content', dark ? 'dark' : 'light');

    els.pageRoot.innerHTML = (PAGE_RENDERERS[state.tab] || renderTasksPage)();
    els.tabbar.innerHTML = renderTabbar();

    var panel = state.panel;
    els.scrim.hidden = !panel;
    els.drawer.hidden = panel !== 'drawer';
    els.sheet.hidden = panel !== 'devices' && panel !== 'attach' && panel !== 'models';
    if (panel === 'drawer') els.drawer.innerHTML = renderDrawer();
    else if (panel === 'devices' || panel === 'attach' || panel === 'models') {
      els.sheet.innerHTML = PANEL_RENDERERS[panel]();
    }

    document.body.setAttribute('data-tab', state.tab);
    document.body.setAttribute('data-panel', panel || 'none');
    if (state.tab === 'tasks' && state.composerFocused) {
      var input = document.getElementById('composer-input');
      if (input) {
        var len = input.value.length;
        var s = (!opts.resetCaret && caret) ? Math.min(caret.s, len) : len;
        var e = (!opts.resetCaret && caret) ? Math.min(caret.e, len) : len;
        input.focus();
        try { input.setSelectionRange(s, e); } catch (err) { /* 某些浏览器对 number 输入抛错 */ }
      }
    }
  }

  // ---------- 宿主动作（M3）：不是空函数，交给宿主注入或至少留下可断言记录 ----------
  function hostAction(name, id) {
    lastAction = { name: name, id: id || null, at: Date.now() };
    if (global.GWorkHost && typeof global.GWorkHost[name] === 'function') {
      try { global.GWorkHost[name](id, getState()); } catch (e) { /* 宿主异常不影响 UI */ }
    }
    saveState();
  }

  function focusPanel() {
    var box = state.panel === 'drawer' ? els.drawer : els.sheet;
    var first = box && box.querySelector('button');
    if (first) { try { first.focus(); } catch (e) {} }
  }

  function openPanel(name) {
    lastTrigger = document.activeElement;
    state.panel = name;
    render();
    focusPanel();
  }

  function closePanel() {
    state.panel = null;
    render();
    if (lastTrigger && document.contains && document.contains(lastTrigger)) {
      try { lastTrigger.focus(); } catch (e) {}
    }
    lastTrigger = null;
  }

  function switchTab(id) {
    if (!D.TABS.some(function (t) { return t.id === id; })) return;
    state.tab = id;
    state.panel = null;
    state.composerFocused = false;
    saveState();
    render();
  }

  var ACTIONS = {
    'switch-tab': function (el) { switchTab(el.getAttribute('data-tab')); },
    'open-drawer': function () { openPanel('drawer'); },
    'open-devices': function () { openPanel('devices'); },
    'open-attach': function () { openPanel('attach'); },
    'open-models': function () { openPanel('models'); },
    'close-panel': function () { closePanel(); },

    'focus-composer': function () { state.composerFocused = true; saveState(); render({ resetCaret: true }); },
    'voice': function () { hostAction('voice'); },
    'send': function () {
      if (!state.composerText.trim()) return;
      state.lastSent = state.composerText;
      state.composerText = '';
      hostAction('send', state.lastSent);
      render();
    },
    'suggestion': function (el) {
      // L4：data-label 统一字符串规范化，绕过 loadState 直接 dispatch 也不抛错
      state.composerText = String(el.getAttribute('data-label') || '');
      state.composerFocused = true;
      saveState();
      render({ resetCaret: true });
    },
    'refresh-suggestions': function () {
      state.suggestionPage = (state.suggestionPage + 1) % D.SUGGESTIONS.length;
      saveState();
      render();
    },

    'loop-tab': function (el) {
      state.loopTab = el.getAttribute('data-tab') === 'results' ? 'results' : 'tasks';
      saveState();
      render();
    },
    'new-loop': function () { hostAction('new-loop'); },
    'new-task': function () {
      state.panel = null;
      state.tab = 'tasks';
      state.composerFocused = true;
      saveState();
      render({ resetCaret: true });
    },
    'discover-row': function (el) { hostAction('discover-row', el.getAttribute('data-id')); },
    'profile': function () { hostAction('profile'); },
    'upgrade': function () { hostAction('upgrade'); },
    'points': function () { hostAction('points'); },

    'set-theme': function (el) {
      var t = el.getAttribute('data-theme');
      if (D.THEMES.indexOf(t) === -1) return;
      state.theme = t;
      saveState();
      render();
    },
    'toggle-haptics': function () { state.haptics = !state.haptics; saveState(); render(); },

    'select-device': function (el) {
      var id = el.getAttribute('data-id');
      if (!D.DEVICES.some(function (d) { return d.id === id; })) return;
      state.deviceId = id;
      hostAction('select-device', id);
      // 选择后顶栏/抽屉的设备文案与图标立即变化（图 74 的可见反馈）
      closePanel();
    },
    'select-model': function (el) {
      var id = el.getAttribute('data-id');
      if (!D.MODELS.some(function (m) { return m.id === id; })) return;
      state.modelId = id;
      hostAction('select-model', id);
      // 选完模型回到聚焦输入态（参考图 79）
      state.composerFocused = true;
      closePanel();
    },
    'quick-action': function (el) { hostAction('quick-action', el.getAttribute('data-id')); },
    'sheet-row': function (el) { hostAction('sheet-row', el.getAttribute('data-id')); }
  };

  // H4：真实点击与 dispatch 共用同一分发路径，不再绕过 handler。
  function invoke(action, el) {
    var handler = ACTIONS[action];
    if (!handler) return false;
    handler(el);
    return true;
  }

  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!el) return;
    // L7：委托注册在 document，冒泡已到最后一站；stopPropagation 无可阻止的监听者。
    // 面板防穿透由 scrim 自身的 click 监听保证（onScrimClick 只绑在 #scrim）。
    if (event.preventDefault) event.preventDefault();
    invoke(el.getAttribute('data-action'), el);
  }

  function onScrimClick(event) {
    if (event && event.target && event.target !== els.scrim) return;
    closePanel();
  }

  function onInput(event) {
    if (!event.target || event.target.id !== 'composer-input') return;
    state.composerText = typeof event.target.value === 'string' ? event.target.value : '';
    var btn = els.pageRoot.querySelector('.send-btn');
    if (btn) {
      var ready = state.composerText.trim().length > 0;
      btn.classList.toggle('is-ready', ready);
      // M2：禁用态与 ready 态同步
      if (ready) btn.removeAttribute('disabled');
      else btn.setAttribute('disabled', '');
      btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
    }
    saveState();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (state.panel) { closePanel(); return; }
      // M2：无面板时 Esc 退出聚焦态，回到图 75 的单行胶囊
      if (state.composerFocused) {
        state.composerFocused = false;
        saveState();
        render();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && event.target && event.target.id === 'composer-input') {
      event.preventDefault();
      ACTIONS.send();
    }
  }

  function onThemeChange() {
    if (state.theme === 'system') render();
  }

  function onHashChange() {
    var id = (location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0];
    if (D.TABS.some(function (t) { return t.id === id; })) switchTab(id);
  }

  function init() {
    els.pageRoot = document.getElementById('page-root');
    els.tabbar = document.getElementById('tabbar');
    els.scrim = document.getElementById('scrim');
    els.drawer = document.getElementById('drawer');
    els.sheet = document.getElementById('sheet');
    if (!els.pageRoot || !els.tabbar || !els.scrim || !els.drawer || !els.sheet) {
      throw new Error('GWork mobile: required DOM nodes are missing');
    }
    render();
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('keydown', onKeyDown);
    els.scrim.addEventListener('click', onScrimClick);
    global.addEventListener('hashchange', onHashChange);
    if (global.matchMedia) {
      var mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', onThemeChange);
      else if (mq.addListener) mq.addListener(onThemeChange);
    }
    // L2：支持冷启动深链 #loop / #discover / #mine / #tasks。
    // 刻意不把 switchTab 回写 hash —— 避免 reload 后残留 hash 干扰干净初始态。
    onHashChange();
  }

  function getState() {
    return Object.assign({}, state, { lastAction: lastAction });
  }

  // 暴露极小的调试/测试接口，不污染全局命名空间
  global.GWorkMobile = {
    init: init,
    getState: getState,
    // 与 onClick 走同一 invoke 路径，测试接口不再拥有独立实现
    dispatch: function (action, attrs) {
      var fake = { getAttribute: function (k) { return (attrs || {})[k]; } };
      return invoke(action, fake);
    },
    render: render
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof window !== 'undefined' ? window : globalThis);
