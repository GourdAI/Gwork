/* GWork 移动端契约测试：node test/mobile-ui.test.js
 * 分层：
 *  1) 数据 / 图标 / 源码样式静态契约（D1–D10，保留原 18 项）
 *  2) 运行时行为契约：Node vm 沙箱加载三个 js + 极简 DOM 桩，真实调用
 *     GWorkMobile 暴露的接口，并通过真实 DOM click 触发事件委托 → ACTIONS，
 *     从而「删掉 ACTIONS 实现」会立刻变红（不再只是字符串包含断言）
 *  3) 选中 Tab 实心图标契约（tab-solid / -solid 变体）
 *  4) ACTIONS 审计 + 真实浏览器交互契约（Edge 缺失时 SKIP，不伪造通过）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p)) || EDGE_CANDIDATES[0];

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};
// vm 沙箱与宿主 Node 是不同 realm，数组/对象原型不同；统一序列化为宿主值再比较。
const eq = (actual, expected, msg) =>
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

// ---------- 加载模块（Node 环境，无 DOM） ----------
const sandbox = { module: { exports: {} }, exports: {}, console, globalThis: null };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/data.js'), sandbox, { filename: 'data.js' });
vm.runInContext(read('js/icons.js'), sandbox, { filename: 'icons.js' });
const D = sandbox.GWorkData;
const I = sandbox.GWorkIcons;

console.log('== 数据契约 ==');
test('底部固定 4 Tab：任务/定时任务/发现/我的（图 75/77/80/81）', () => {
  eq(D.TABS.map(t => t.id), ['tasks', 'loop', 'discover', 'mine']);
  eq(D.TABS.map(t => t.label), ['任务', '定时任务', '发现', '我的']);
});
test('首页 4 个建议胶囊 + 换一换（图 75）', () => {
  assert.strictEqual(D.SUGGESTIONS[0].length, 4);
  eq(D.SUGGESTIONS[0].map(s => s.label),
    ['进行数据分析及可视化', '进行文档处理', '做一份幻灯片', '制作工作台']);
  assert.ok(D.SUGGESTIONS.length > 1, '换一换必须有第二组数据');
  assert.notStrictEqual(JSON.stringify(D.SUGGESTIONS[1].map(s => s.label)), JSON.stringify(D.SUGGESTIONS[0].map(s => s.label)));
});
test('发现页 3 个分组卡片（图 80）', () => {
  assert.strictEqual(D.DISCOVER_GROUPS.length, 3);
  eq(D.DISCOVER_GROUPS.map(g => g.length), [1, 3, 1]);
  eq(D.DISCOVER_GROUPS[1].map(r => r.label), ['专家', '技能', '连接器']);
});
test('我的页设置行与主题三态（图 81）', () => {
  eq(D.SETTINGS_ROWS.map(r => r.label),
    ['语言', '字体大小', '朗读设置', '触感反馈', '存储空间', '消息通知设置']);
  eq(D.THEMES, ['system', 'light', 'dark']);
  assert.strictEqual(D.DEFAULT_THEME, 'system', '主题默认必须是「系统」');
});
test('＋扩展面板：3 宫格 + 5 行列表（图 78）', () => {
  eq(D.QUICK_ACTIONS.map(a => a.label), ['拍照', '照片 / 视频', '添加文件']);
  eq(D.SHEET_LIST_ROWS.map(r => r.label), ['专家', '技能', '连接器', '定时任务', '录音笔']);
});
test('选择设备 sheet：云端勾选 / 笔记本离线（图 74）', () => {
  assert.strictEqual(D.DEVICES.length, 2);
  assert.strictEqual(D.DEVICES[0].id, 'cloud');
  assert.strictEqual(D.DEVICES[0].selected, true);
  assert.strictEqual(D.DEVICES[1].offline, true);
});
test('选择模型 sheet：8 行 + Hy3 限时免费且选中（图 82）', () => {
  eq(D.MODELS.map(m => m.name),
    ['快速', '均衡', '极致', 'Hy4 preview', 'Hy3', 'DeepSeek-V4.1-Flash', 'GLM-5.3', 'GLM-5.3-Flash']);
  const hy3 = D.MODELS.find(m => m.id === 'hy3');
  assert.strictEqual(hy3.free, true);
  assert.strictEqual(hy3.selected, true);
  assert.strictEqual(hy3.ratio, '0.00x');
});
test('强调色为青绿（图 77 FAB / 81 开关 / 74 勾选）', () => {
  assert.strictEqual(D.ACCENT, '#0fbc9b');
});
test('品牌为 GWork 自有商标（文案 + 图形资源）', () => {
  assert.strictEqual(D.BRAND.name, 'GWork', '顶栏品牌名必须是 GWork');
  assert.strictEqual(D.BRAND.welcome, 'GWork，我帮你', '欢迎语必须是 GWork');
  assert.ok(/gwork-logo\.png$/.test(D.BRAND.logo), '必须引用 GWork 官方图形商标 PNG');
  assert.ok(!/WorkBuddy/.test(JSON.stringify(D.BRAND)), '品牌数据不得残留 WorkBuddy');
});

console.log('== 图标契约 ==');
test('所有数据引用的图标均已定义且为合法 SVG', () => {
  const names = new Set();
  D.TABS.forEach(t => names.add(t.icon));
  D.SUGGESTIONS.forEach(g => g.forEach(s => names.add(s.icon)));
  D.DISCOVER_GROUPS.forEach(g => g.forEach(r => names.add(r.icon)));
  D.QUICK_ACTIONS.forEach(a => names.add(a.icon));
  D.SHEET_LIST_ROWS.forEach(r => names.add(r.icon));
  D.DEVICES.forEach(d => names.add(d.icon));
  D.MODELS.forEach(m => names.add(m.icon));
  const all = I.all();
  names.forEach(n => {
    assert.ok(all.includes(n), '缺少图标: ' + n);
    const svg = I.get(n);
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), '图标不是完整 SVG: ' + n);
    assert.ok(svg.includes('stroke="currentColor"'), '图标未使用 currentColor: ' + n);
  });
});

console.log('== 源码/样式契约（杜绝旧版 10 项偏差回归） ==');
const html = read('index.html');
const css = read('css/app.css');
const theme = read('css/theme.css');
const app = read('js/app.js');

// =====================================================================
// 极简 DOM 桩：解析 app.js 生成的 HTML 字符串为可查询的元素树，
// 支持事件冒泡（document 上的 click 委托）、属性/class/dataset、焦点、
// localStorage、getComputedStyle 等。用于「运行时行为契约」。
// =====================================================================
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source',
  'area', 'base', 'col', 'embed', 'param', 'track', 'wbr', 'path', 'circle',
  'rect', 'line', 'polyline', 'polygon', 'ellipse', 'use', 'stop']);

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

class El {
  constructor(tag, attrs, ownerDoc) {
    this.nodeType = 'element';
    this.tagName = String(tag).toUpperCase();
    this.tag = String(tag).toLowerCase();
    this.ownerDocument = ownerDoc;
    this.attrs = {};
    this.dataset = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this._innerHTML = '';
    this.hidden = false;
    this.focused = false;
    this._value = undefined;
    this._text = '';
    this._cl = null;
    Object.keys(attrs || {}).forEach(k => this.setAttribute(k, attrs[k]));
  }
  setAttribute(n, v) {
    v = String(v);
    this.attrs[n] = v;
    if (n.indexOf('data-') === 0) this.dataset[camel(n.slice(5))] = v;
  }
  getAttribute(n) {
    if (Object.prototype.hasOwnProperty.call(this.attrs, n)) return this.attrs[n];
    if (n.indexOf('data-') === 0) {
      const k = camel(n.slice(5));
      if (Object.prototype.hasOwnProperty.call(this.dataset, k)) return this.dataset[k];
    }
    return null;
  }
  removeAttribute(n) {
    delete this.attrs[n];
    if (n.indexOf('data-') === 0) delete this.dataset[camel(n.slice(5))];
  }
  hasAttribute(n) { return this.getAttribute(n) !== null; }
  _classes() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _setClasses(a) { this.setAttribute('class', a.join(' ')); }
  get classList() {
    if (!this._cl) {
      const self = this;
      this._cl = {
        contains: (c) => self._classes().indexOf(c) !== -1,
        add: (c) => { const a = self._classes(); if (a.indexOf(c) === -1) { a.push(c); self._setClasses(a); } },
        remove: (c) => self._setClasses(self._classes().filter(x => x !== c)),
        toggle: (c, force) => {
          const has = self._cl.contains(c);
          const on = force === undefined ? !has : !!force;
          if (on) self._cl.add(c); else self._cl.remove(c);
          return on;
        }
      };
    }
    return this._cl;
  }
  get className() { return this.getAttribute('class') || ''; }
  get id() { return this.getAttribute('id') || ''; }
  get value() { return this._value !== undefined ? this._value : (this._text || ''); }
  set value(v) { this._value = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v);
    this._text = '';
    parseHTML(this._innerHTML, this.ownerDocument, this);
  }
  focus() { this.focused = true; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setSelectionRange(a, b) { this._sel = [a, b]; }
  addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
  removeEventListener(t, fn) {
    const a = this.listeners[t] || [];
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(evt) {
    if (typeof evt === 'string') evt = { type: evt };
    if (!evt.target) evt.target = this;
    if (!evt.preventDefault) evt.preventDefault = function () { this.defaultPrevented = true; };
    if (!evt.stopPropagation) evt.stopPropagation = function () { this._stopped = true; };
    let node = this;
    while (node) {
      const ls = (node.listeners && node.listeners[evt.type]) || [];
      for (const fn of ls.slice()) fn.call(node, evt);
      if (evt._stopped) break;
      node = node.parentNode || null;
    }
    return !evt.defaultPrevented;
  }
  click() { return this.dispatchEvent({ type: 'click', bubbles: true }); }
  querySelectorAll(sel) { return queryAll(sel, this); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementById(id) { return findById(id, this); }
  closest(sel) {
    const segs = splitSelector(sel).map(parseCompound);
    const c = segs[segs.length - 1];
    let n = this;
    while (n && n.nodeType === 'element') {
      if (matches(n, c)) return n;
      n = n.parentNode;
    }
    return null;
  }
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
  }
  return attrs;
}

function parseHTML(html, doc, container) {
  const stack = [container];
  container.children = [];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const cur = stack[stack.length - 1];
      cur._text = (cur._text || '') + m[5];
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const el = new El(tag, parseAttrs(m[3] || ''), doc);
    el.parentNode = stack[stack.length - 1];
    stack[stack.length - 1].children.push(el);
    if (!(m[4] === '/' || VOID_TAGS.has(tag))) stack.push(el);
  }
  // textarea / input 的 value 来自其内容文本
  walk(container, (e) => {
    if ((e.tag === 'textarea' || e.tag === 'input') && e._text) e.value = e._text;
  });
  return container.children;
}

function walk(node, fn) {
  const kids = node && node.children;
  if (!kids) return;
  for (const c of kids) {
    if (c && c.nodeType === 'element') { fn(c); walk(c, fn); }
  }
}
function allElements(root) { const out = []; walk(root, (e) => out.push(e)); return out; }
function findById(id, root) {
  let found = null;
  walk(root, (e) => { if (!found && e.getAttribute('id') === id) found = e; });
  return found;
}
function splitSelector(sel) {
  const parts = []; let cur = '', depth = 0, quote = null;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') { depth++; cur += ch; continue; }
    if (ch === ']') { depth--; cur += ch; continue; }
    if (/\s/.test(ch) && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : ['*'];
}
function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) { if (!out.tag) out.tag = m[1].toLowerCase(); }
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) {
      const a = m[4];
      const eqm = a.match(/^([\w-]+)(?:=["']?([^"'\]]*)["']?)?$/);
      if (eqm) out.attrs.push({ name: eqm[1], value: eqm[2] === undefined ? null : eqm[2] });
    }
  }
  return out;
}
function matches(el, c) {
  if (!el || el.nodeType !== 'element') return false;
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}
function matchDescendant(el, segs) {
  let i = segs.length - 1;
  if (!matches(el, segs[i])) return false;
  i--;
  let p = el.parentNode;
  while (i >= 0) {
    let found = null;
    while (p) { if (matches(p, segs[i])) { found = p; break; } p = p.parentNode; }
    if (!found) return false;
    p = found.parentNode;
    i--;
  }
  return true;
}
function queryAll(sel, root) {
  const segs = splitSelector(sel).map(parseCompound);
  return allElements(root).filter((e) => matchDescendant(e, segs));
}

class DomEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.defaultPrevented = false;
    this._stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}

/** 创建一个全新的 vm 运行时（每个测试用例独立，避免状态互相污染）。 */
function boot(opts) {
  opts = opts || {};
  const sb = {
    console,
    // window / globalThis 由 vm 自动提供 globalThis；window 指向同一全局
    location: { hash: opts.hash || '' },
    history: {
      replaceState: (a, b, url) => {
        if (url) { const s = String(url), i = s.indexOf('#'); if (i >= 0) sb.location.hash = s.slice(i); }
      },
      pushState: (a, b, url) => {
        if (url) { const s = String(url), i = s.indexOf('#'); if (i >= 0) sb.location.hash = s.slice(i); }
      }
    },
    matchMedia: () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    Event: DomEvent,
    MouseEvent: class MouseEvent extends DomEvent {},
    CustomEvent: DomEvent
  };
  sb.window = sb;

  const store = Object.create(null);
  if (opts.seed) store['gwork.mobile.state.v1'] = JSON.stringify(opts.seed);
  const localStorage = {
    getItem: (k) => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); }
  };
  sb.localStorage = localStorage;

  const winListeners = {};
  sb.addEventListener = (t, fn) => { (winListeners[t] || (winListeners[t] = [])).push(fn); };
  sb.removeEventListener = (t, fn) => {
    const a = winListeners[t] || [], i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };

  const doc = {
    nodeType: 'document',
    readyState: opts.readyState || 'complete',
    listeners: {},
    children: [],
    activeElement: null,
    parentNode: null,
    addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); },
    removeEventListener(t, fn) {
      const a = this.listeners[t] || [], i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatchEvent(evt) {
      if (!evt.target) evt.target = this;
      if (!evt.preventDefault) evt.preventDefault = function () { this.defaultPrevented = true; };
      if (!evt.stopPropagation) evt.stopPropagation = function () { this._stopped = true; };
      const ls = (this.listeners[evt.type] || []).slice();
      for (const fn of ls) fn.call(this, evt);
      return !evt.defaultPrevented;
    },
    querySelectorAll(sel) { return queryAll(sel, this); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    getElementById(id) { return findById(id, this); },
    createElement(tag) { return new El(tag, {}, this); }
  };
  doc.documentElement = new El('html', { 'data-theme': 'system' }, doc);
  doc.documentElement.parentNode = doc;
  doc.head = new El('head', {}, doc);
  doc.head.parentNode = doc.documentElement;
  const meta = new El('meta', { name: 'theme-color', content: '#fafafa' }, doc);
  meta.parentNode = doc.head;
  doc.head.children.push(meta);
  doc.body = new El('body', {}, doc);
  doc.body.parentNode = doc.documentElement;
  doc.documentElement.children = [doc.head, doc.body];
  doc.children = [doc.documentElement];

  const roots = [
    ['page-root', 'main', { id: 'page-root', class: 'page-root' }],
    ['tabbar', 'nav', { id: 'tabbar', class: 'tabbar' }],
    ['scrim', 'div', { id: 'scrim', class: 'scrim', hidden: '' }],
    ['drawer', 'aside', { id: 'drawer', class: 'drawer', hidden: '' }],
    ['sheet', 'section', { id: 'sheet', class: 'sheet', hidden: '' }]
  ];
  roots.forEach(([, tag, attrs]) => {
    const el = new El(tag, attrs, doc);
    el.parentNode = doc.body;
    if (attrs.hidden !== undefined) el.hidden = true;
    doc.body.children.push(el);
  });

  const getComputedStyle = () => {
    const t = doc.documentElement.getAttribute('data-theme');
    return {
      backgroundColor: t === 'dark' ? 'rgb(20, 20, 22)' : 'rgb(250, 250, 250)',
      color: t === 'dark' ? 'rgb(245, 245, 247)' : 'rgb(20, 20, 22)'
    };
  };
  sb.getComputedStyle = getComputedStyle;
  doc.defaultView = { getComputedStyle };
  sb.document = doc;

  vm.createContext(sb);
  vm.runInContext(read('js/data.js'), sb, { filename: 'data.js' });
  vm.runInContext(read('js/icons.js'), sb, { filename: 'icons.js' });
  vm.runInContext(read('js/app.js'), sb, { filename: 'app.js' });

  return {
    sandbox: sb,
    doc,
    Event: sb.Event,
    MouseEvent: sb.MouseEvent,
    get api() { return sb.GWorkMobile; },
    state() { return sb.GWorkMobile.getState(); },
    q(sel) { return doc.querySelector(sel); },
    qa(sel) { return doc.querySelectorAll(sel); },
    click(sel) {
      const el = doc.querySelector(sel);
      if (!el) throw new Error('找不到可点击元素: ' + sel);
      el.click();
      return el;
    },
    dispatch(action, attrs) { return sb.GWorkMobile.dispatch(action, attrs || {}); }
  };
}

/** 精确结构检查：渲染后的真实 DOM 里不允许 button 嵌套 button。 */
function assertNoNestedButton(rt) {
  const buttons = rt.qa('button');
  assert.ok(buttons.length > 0, '渲染结果应包含 button');
  buttons.forEach((b) => {
    let p = b.parentNode;
    while (p && p.nodeType === 'element') {
      assert.notStrictEqual(p.tagName, 'BUTTON',
        'button 不得内嵌 button：' + (b.getAttribute('data-action') || b.className || b.tagName));
      p = p.parentNode;
    }
  });
}

test('无启动配对门禁，4 个 Tab 页与 4 个面板节点齐备', () => {
  assert.ok(!html.includes('pair'), '不得存在配对页');
  assert.ok(!/连接你的\s*GWork\s*内核/.test(app), '不得存在配对表单文案');
  ['page-root', 'tabbar', 'scrim', 'drawer', 'sheet'].forEach(id =>
    assert.ok(html.includes('id="' + id + '"'), '缺少节点 #' + id));
  assert.ok(app.includes("'open-drawer'") && app.includes("'open-devices'") &&
    app.includes("'open-attach'") && app.includes("'open-models'"), '缺少 4 个面板入口');
});
test('默认主题为系统且浅色为默认观感，保留三态（修 D1）', () => {
  assert.ok(html.includes('data-theme="system"'));
  assert.ok(theme.includes('html[data-theme="light"]'));
  assert.ok(theme.includes('html[data-theme="dark"]'));
  assert.ok(theme.includes('prefers-color-scheme: dark'));
  assert.ok(app.includes("'set-theme'"));
});
test('页面铺满视口且滚动容器正确（修 D2）', () => {
  assert.ok(css.includes('100dvh'), '必须用 dvh 铺满动态视口');
  assert.ok(/\.page-root\s*\{[^}]*flex:\s*1 1 auto/.test(css));
  assert.ok(css.includes('min-height: 0'), 'flex 子项必须允许收缩');
});
test('底部 4 Tab 由数据驱动且无顶部分隔线（修 D4）', () => {
  assert.ok(app.includes('function renderTabbar'));
  assert.ok(app.includes('D.TABS.map'));
  assert.ok(!/\.tabbar\s*\{[^}]*border-top/.test(css), '参考图无顶部分隔线');
});
test('首页欢迎态：机器人 / 大标题 / 建议 / 两态输入（修 D5/D7）', () => {
  assert.ok(app.includes('hero-robot') && app.includes('hero-title'));
  assert.ok(app.includes('renderComposer'));
  assert.ok(app.includes('composer-idle') && app.includes('composer-focus'));
  assert.ok(app.includes("'open-models'"), '聚焦态必须有模型选择器');
  assert.ok(app.includes("'open-attach'"), '聚焦态必须有 ＋');
  assert.ok(css.includes('caret-color: var(--accent)'), '光标必须为青绿');
});
test('顶栏为圆形「＝」+ 品牌标题，无返回箭头（修 D6）', () => {
  assert.ok(app.includes("icon('menu')"));
  assert.ok(app.includes('round-btn'));
  assert.ok(app.includes('brand-name'));
  // 品牌：文案 GWork + 官方图形商标（不是纯文字），且 favicon/title 同步
  assert.ok(html.includes('<title>GWork</title>'), 'title 必须为 GWork');
  assert.ok(html.includes('assets/gwork-logo.png'), 'favicon 必须指向 GWork 商标 PNG');
  assert.ok(!html.includes('href="data:,"'), 'favicon 不得再是空 data URI');
  assert.ok(app.includes('brand-logo') && app.includes('D.BRAND.logo'), '顶栏必须渲染图形商标');
  assert.ok(css.includes('.brand-logo'), '图形商标必须有尺寸样式');
  assert.ok(!/WorkBuddy/.test(app) && !/WorkBuddy/.test(html), '渲染层不得残留 WorkBuddy');
  // 原第 137 行源码正则不可靠（字符串拼接生成的 HTML 匹配不到真实嵌套）；
  // 改为对 app.js 实际渲染出的 DOM 树做精确结构检查（含聚焦态与 4 个面板态）。
  const idle = boot();
  assertNoNestedButton(idle);
  idle.click('[data-action="focus-composer"]');
  assertNoNestedButton(idle);
  ['open-drawer', 'open-devices', 'open-attach', 'open-models'].forEach((a) => {
    const r = boot();
    if (a === 'open-attach' || a === 'open-models') r.click('[data-action="focus-composer"]');
    r.click('[data-action="' + a + '"]');
    assertNoNestedButton(r);
  });
  assert.ok(app.includes("data-action=\"focus-composer\""), '未聚焦输入态必须可点击');
  // 运行时 DOM：顶栏真实存在 GWork 文字 + 图形商标 img（src/alt 均正确）
  const home = boot();
  const brandName = home.q('.brand-name');
  const logo = home.q('.brand-logo');
  const title = home.q('.hero-title');
  assert.ok(brandName && brandName.value.trim() === 'GWork', '顶栏应显示 GWork');
  assert.ok(logo && logo.getAttribute('src') === './assets/gwork-logo.png', '顶栏商标应指向官方 PNG');
  assert.ok(logo.getAttribute('alt') === 'GWork 商标', '商标应有可访问名称');
  assert.ok(title && title.value.trim() === 'GWork，我帮你', '欢迎语应为 GWork，我帮你');
});
test('定时任务双 Tab + 空态 + 青绿 FAB（修 D8）', () => {
  assert.ok(app.includes('segment-tabs') && app.includes("'loop-tab'"));
  assert.ok(app.includes('暂无自动化任务'));
  assert.ok(css.includes('background: var(--accent)'), 'FAB 必须用青绿');
});
test('hidden 属性优先级兜底存在（面板可关闭）', () => {
  assert.ok(css.includes('[hidden] { display: none !important; }'));
});
test('app.js 语法可通过解析', () => {
  new vm.Script(app, { filename: 'app.js' });
});

// =====================================================================
console.log('== 选中 Tab 实心图标契约（图 75/77/80/81） ==');
test('app.js renderTabbar 选中态渲染 tab-solid 逻辑', () => {
  assert.ok(app.includes('tab-solid'), 'app.js 必须包含 tab-solid 渲染逻辑');
  const idx = app.indexOf('renderTabbar');
  assert.ok(idx >= 0, '找不到 renderTabbar');
  const region = app.slice(idx, idx + 900);
  assert.ok(/tab-solid/.test(region), 'tab-solid 必须出现在 renderTabbar 内');
  assert.ok(/active|state\.tab/i.test(region), 'tab-solid 必须按选中态条件渲染');
});
test('icons.js 中 4 个 Tab 图标均有对应 solid 实心变体', () => {
  const names = D.TABS.map((t) => t.icon);
  const all = I.all();
  names.forEach((n) => {
    assert.ok(all.some((k) => k.indexOf(n) === 0 && /solid/i.test(k)),
      '缺少实心图标变体: ' + n + '-solid（当前图标: ' + all.filter(k => k.indexOf(n) === 0).join(',') + '）');
  });
});
test('运行时：选中 Tab 使用实心图标，未选中 Tab 使用线性图标', () => {
  const rt = boot();
  const active = rt.q('.tab-item.is-active');
  assert.ok(active, '应存在选中态 .tab-item.is-active');
  assert.ok(/\btab-solid\b/.test(active.innerHTML) || active.querySelector('.tab-solid'),
    '选中 Tab 必须渲染 tab-solid 实心图标');
  rt.qa('.tab-item').filter((e) => !e.classList.contains('is-active')).forEach((e) => {
    assert.ok(!/\btab-solid\b/.test(e.innerHTML), '未选中 Tab 不应使用实心图标');
  });
});

// =====================================================================
console.log('== 运行时行为契约（vm DOM 桩 / 真实接口调用） ==');
test('导出 init/getState/dispatch/render，自动 init 渲染 4 个 .tab-item', () => {
  const rt = boot();
  ['init', 'getState', 'dispatch', 'render'].forEach((k) =>
    assert.strictEqual(typeof rt.api[k], 'function', '缺少导出接口: ' + k));
  assert.strictEqual(rt.qa('.tab-item').length, 4, '4 个 Tab 必须渲染出 4 个 .tab-item');
  const s = rt.state();
  assert.strictEqual(s.tab, 'tasks');
  assert.strictEqual(s.theme, 'system');
  assert.strictEqual(s.panel, null);
  assert.strictEqual(rt.doc.body.dataset.tab, 'tasks');
  assert.strictEqual(rt.doc.body.dataset.panel, 'none');
  assert.strictEqual(rt.doc.documentElement.dataset.theme, 'system');
});
test('readyState=loading 下显式调用 init() 完成渲染', () => {
  const rt = boot({ readyState: 'loading' });
  assert.strictEqual(rt.qa('.tab-item').length, 0, 'loading 态不应自动渲染');
  assert.doesNotThrow(() => rt.api.init(), 'init() 不应抛异常');
  assert.strictEqual(rt.qa('.tab-item').length, 4);
});
test('真实 DOM click 走事件委托：switch-tab 后 getState().tab / dataset.tab 同步变化', () => {
  const rt = boot();
  for (const id of ['loop', 'discover', 'mine', 'tasks']) {
    const el = rt.q('[data-action="switch-tab"][data-tab="' + id + '"]');
    assert.ok(el, '缺少 Tab 按钮: ' + id);
    el.click();
    assert.strictEqual(rt.state().tab, id, 'click 后 state.tab 应为 ' + id);
    assert.strictEqual(rt.doc.body.dataset.tab, id, 'body.dataset.tab 应为 ' + id);
    const active = rt.q('.tab-item.is-active');
    assert.ok(active && active.getAttribute('data-tab') === id, '选中态 class 应落在 ' + id);
  }
});
test('MouseEvent 冒泡路径：dispatchEvent(new MouseEvent(...)) 同样触发 switch-tab', () => {
  const rt = boot();
  const el = rt.q('[data-action="switch-tab"][data-tab="discover"]');
  assert.ok(el);
  el.dispatchEvent(new rt.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.strictEqual(rt.state().tab, 'discover', '冒泡 click 应触发 document 上的事件委托');
});
test('dispatch("switch-tab") 直接调用契约（委托同一动作路径）', () => {
  const rt = boot();
  rt.dispatch('switch-tab', { 'data-tab': 'loop' });
  assert.strictEqual(rt.state().tab, 'loop');
  assert.strictEqual(rt.doc.body.dataset.tab, 'loop');
});
test('4 个面板真实点击 open → getState().panel 正确 → 点击 scrim close 回 null', () => {
  const panels = [
    ['drawer', 'open-drawer', false, '#drawer', '.new-task-btn'],
    ['devices', 'open-devices', false, '#sheet', '.device-row'],
    ['attach', 'open-attach', true, '#sheet', '.quick-cell'],
    ['models', 'open-models', true, '#sheet', '.model-row']
  ];
  panels.forEach(([name, action, needFocus, boxSel, contentSel]) => {
    const rt = boot();
    if (needFocus) rt.click('[data-action="focus-composer"]');
    rt.click('[data-action="' + action + '"]');
    assert.strictEqual(rt.state().panel, name, name + ' 打开后 state.panel 应为 ' + name);
    assert.strictEqual(rt.doc.body.dataset.panel, name);
    const box = rt.q(boxSel);
    assert.ok(box && box.hidden === false, name + ' 容器应可见');
    assert.ok(rt.qa(contentSel).length > 0, name + ' 面板内容应被真实渲染');
    rt.click('#scrim');
    assert.strictEqual(rt.state().panel, null, name + ' 遮罩点击后应关闭');
    assert.strictEqual(rt.doc.body.dataset.panel, 'none');
    assert.strictEqual(rt.q(boxSel).hidden, true, name + ' 容器应重新隐藏');
  });
});
test('set-theme 三态：真实点击后 state.theme / data-theme / 选中态一致', () => {
  const rt = boot();
  rt.click('[data-action="switch-tab"][data-tab="mine"]');
  for (const t of ['light', 'dark', 'system']) {
    const el = rt.q('[data-action="set-theme"][data-theme="' + t + '"]');
    assert.ok(el, '缺少主题按钮: ' + t);
    el.click();
    assert.strictEqual(rt.state().theme, t);
    assert.strictEqual(rt.doc.documentElement.getAttribute('data-theme'), t);
    assert.strictEqual(rt.doc.documentElement.dataset.theme, t);
    const active = rt.q('.theme-segment .is-active');
    assert.ok(active && active.getAttribute('data-theme') === t, '主题分段选中态应为 ' + t);
  }
});
test('refresh-suggestions 轮换且建议数量保持 4', () => {
  const rt = boot();
  const p0 = rt.state().suggestionPage;
  assert.strictEqual(rt.qa('.suggestion').length, 4);
  rt.click('[data-action="refresh-suggestions"]');
  const p1 = rt.state().suggestionPage;
  assert.notStrictEqual(p1, p0, '换一换必须轮换建议组');
  assert.strictEqual(p1, (p0 + 1) % D.SUGGESTIONS.length);
  assert.strictEqual(rt.qa('.suggestion').length, 4);
  rt.click('[data-action="refresh-suggestions"]');
  assert.strictEqual(rt.state().suggestionPage, p0, '二次轮换应回到初始组');
});
test('select-device 更新 deviceId 并关闭面板', () => {
  const rt = boot();
  rt.click('[data-action="open-devices"]');
  rt.click('[data-action="select-device"][data-id="laptop"]');
  assert.strictEqual(rt.state().deviceId, 'laptop');
  assert.strictEqual(rt.state().panel, null);
});
test('select-model 更新 modelId 并保持聚焦输入态', () => {
  const rt = boot();
  rt.click('[data-action="focus-composer"]');
  rt.click('[data-action="open-models"]');
  rt.click('[data-action="select-model"][data-id="ds"]');
  assert.strictEqual(rt.state().modelId, 'ds');
  assert.strictEqual(rt.state().panel, null);
  assert.strictEqual(rt.state().composerFocused, true);
});
test('toggle-haptics 反转且开关 class 同步', () => {
  const rt = boot();
  rt.click('[data-action="switch-tab"][data-tab="mine"]');
  const before = rt.state().haptics;
  rt.click('[data-action="toggle-haptics"]');
  assert.strictEqual(rt.state().haptics, !before);
  assert.strictEqual(rt.q('.switch').classList.contains('is-on'), !before);
  rt.click('[data-action="toggle-haptics"]');
  assert.strictEqual(rt.state().haptics, before);
});
test('输入两态 + send：输入后 ready、点击发送清空 composerText', () => {
  const rt = boot();
  rt.click('[data-action="focus-composer"]');
  const input = rt.q('#composer-input');
  assert.ok(input, '聚焦态必须存在 #composer-input');
  input.value = '测试消息';
  input.dispatchEvent(new rt.Event('input', { bubbles: true }));
  assert.strictEqual(rt.state().composerText, '测试消息');
  assert.ok(rt.q('.send-btn').classList.contains('is-ready'), '发送按钮应进入 ready 态');
  rt.click('.send-btn');
  assert.strictEqual(rt.state().composerText, '', '发送后必须清空文本');
});
test('脏 localStorage 下 init 不抛异常且 suggestionPage 回退 0、页面不白屏', () => {
  const rt = boot({
    seed: {
      tab: 'bogus', theme: 'neon', composerText: { x: 1 }, suggestionPage: 99,
      modelId: 'nope', deviceId: 'nope', panel: 'garbage', haptics: 'yes'
    }
  });
  const s = rt.state();
  assert.strictEqual(s.tab, 'tasks');
  assert.strictEqual(s.theme, 'system');
  assert.strictEqual(s.suggestionPage, 0);
  assert.strictEqual(s.composerText, '');
  assert.strictEqual(s.modelId, 'hy3');
  assert.strictEqual(s.deviceId, 'cloud');
  assert.strictEqual(s.panel, null);
  assert.strictEqual(rt.qa('.tab-item').length, 4, '脏数据下仍应渲染 4 个 Tab');
  assert.strictEqual(rt.qa('.suggestion').length, 4, '脏数据下仍应渲染 4 个建议');
  assert.doesNotThrow(() => rt.api.render(), '脏数据下 render 不应抛异常');
});

// =====================================================================
console.log('== ACTIONS 审计 / 真实浏览器交互契约 ==');
test('action-audit.cjs：data-action ↔ ACTIONS 一一对应（零死按钮）', () => {
  const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'action-audit.cjs')], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.strictEqual(r.status, 0, 'action-audit.cjs 退出码 ' + r.status + '\n' + out);
  assert.ok(/按钮无处理器:\s*\[\]/.test(r.stdout || ''), '存在无处理器的 data-action\n' + out);
  assert.ok(/处理器无 UI 入口:\s*\[\]/.test(r.stdout || ''), '存在无 UI 入口的 ACTIONS\n' + out);
  assert.ok(/dispatch 测试接口存在:\s*true/.test(r.stdout || ''), 'dispatch 测试接口缺失\n' + out);
});
if (!fs.existsSync(EDGE)) {
  console.log('  SKIP  interaction.cjs（本机未安装 Edge，真实浏览器交互契约跳过；不计入通过/失败）');
} else {
  test('interaction.cjs 真实 DOM 点击回归通过（36 项）', () => {
    const r = cp.spawnSync(process.execPath, [path.join(__dirname, 'interaction.cjs')],
      { encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 0, 'interaction.cjs 退出码 ' + r.status + '\n' + out.slice(-1800));
    // Edge 已由本文件确认存在，因此不得用 SKIP 顶替真实通过
    assert.ok(/\d+\s*通过\s*\/\s*0\s*失败/.test(r.stdout || ''),
      'interaction.cjs 未报告 0 失败\n' + out.slice(-1800));
    assert.ok(!/SKIP/.test(out), 'Edge 存在但 interaction.cjs 报告了 SKIP\n' + out.slice(-1800));
  });
}

console.log('\n' + passed + ' 项契约测试通过');
if (process.exitCode) console.error('存在失败项');
