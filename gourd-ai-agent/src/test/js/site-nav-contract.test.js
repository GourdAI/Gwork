/**
 * 契约测试：官网顶部导航条公共实现（js/site-nav.js）。
 *
 * 背景：index.html 与 models.html 原先各写一套导航 JS —— main.js 带完整的移动端菜单收起
 * （点链接 / 点外部 / Esc + aria-label 同步），models.js 只绑了开合，导致模型页点导航项后
 * 菜单残留在展开态。现合并为单份实现，本测试锁住两类事实：
 *   A. 行为：三种关闭路径 + aria 同步 + 滚动接管，全部在真实源码沙箱里执行（不是正则扫描）；
 *   B. 形态：单一实现、两页加载顺序、两页参数差异（尤其 models 的常驻 scrolled 不得被夺走）；
 *   C. 嵌入判定：只认地址栏 embed 参数，iframe 嵌套不再自动隐藏导航（默认一律展示）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 本文件位于 <repo>/gourd-ai-agent/src/test/js/，上溯四级才是仓库根（gourd-ai-website 的兄弟目录是 gourd-ai-agent）
const siteRoot = path.resolve(__dirname, '../../../../gourd-ai-website');
const readSite = (...parts) => fs.readFileSync(path.join(siteRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const siteNavSrc = readSite('js', 'site-nav.js');
const mainSrc = readSite('js', 'main.js');
const modelsSrc = readSite('js', 'models.js');
const indexHtml = readSite('index.html');
const modelsHtml = readSite('models.html');

/* ---------------- 最小 DOM / 浏览器桩 ---------------- */

function classList(el) {
  const set = () => new Set((el.className || '').split(/\s+/).filter(Boolean));
  const write = s => { el.className = [...s].join(' '); };
  return {
    add: c => { const s = set(); s.add(c); write(s); },
    remove: c => { const s = set(); s.delete(c); write(s); },
    contains: c => set().has(c),
    toggle: (c, force) => {
      const s = set();
      const on = force === undefined ? !s.has(c) : !!force;
      on ? s.add(c) : s.delete(c);
      write(s);
      return on;
    },
  };
}

function el(id, className) {
  const node = {
    id,
    className: className || '',
    attrs: Object.create(null),
    listeners: Object.create(null),
    children: [],
    setAttribute: (k, v) => { node.attrs[k] = String(v); },
    getAttribute: k => (k in node.attrs ? node.attrs[k] : null),
    addEventListener: (type, fn) => { (node.listeners[type] ||= []).push(fn); },
    querySelectorAll: () => node.children,
    // closest('.site-header') 语义：自身带该类则命中
    closest: sel => (sel && sel[0] === '.' && node.classList.contains(sel.slice(1)) ? node : null),
    fire(type, ev) { (node.listeners[type] || []).forEach(fn => fn(ev || { target: node })); return node; },
  };
  node.classList = classList(node);
  return node;
}

function anchor(href, insideHeader) {
  const a = el('a');
  a.attrs.href = href;
  // closest('.site-header') 语义：头部内的项返回头部，否则 null
  a.closest = sel => (sel === '.site-header' && insideHeader ? (a._header || null) : null);
  return a;
}

/**
 * 装载并执行真实的 site-nav.js。
 * opts.embedded  -> <html class="is-embedded">
 * opts.headerClass -> header 初始类（models.html 是 'site-header scrolled'）
 */
function mount(opts) {
  const o = opts || {};
  const header = el('siteHeader', o.headerClass || 'site-header');
  const toggle = el('navToggle');
  const links = el('navLinks');
  links.children = [
    anchor('#features', true),
    anchor('#quickstart', true),
    anchor('#downloads', true),
    anchor('https://api.gourdwork.com', true),
  ].map(a => { a._header = header; return a; });

  const byId = { siteHeader: header, navToggle: toggle, navLinks: links };
  const docListeners = Object.create(null);
  const winListeners = Object.create(null);
  const doc = {
    documentElement: { className: o.embedded ? 'is-embedded' : '', scrollHeight: 20000 },
    getElementById: id => byId[id] || null,
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
  };
  const win = {
    scrollY: 0,
    innerHeight: 800,
    addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); },
    document: doc,
  };

  // 形参注入 window/document，执行磁盘上的真实源码；不使用任何自造便利入口
  const api = new Function('window', 'document', siteNavSrc + '\nreturn window.GourdSiteNav;')(win, doc);
  if (api && typeof api.setupNav === 'function') api.setupNav(o.nav || {});

  return {
    header, toggle, links, win, anchors: links.children,
    nav: (opts.nav || {}),
    scroll: (winListeners.scroll || []),
    docListenerCount: Object.keys(docListeners).length,
    winListenerCount: Object.keys(winListeners).length,
    openMenu: () => toggle.fire('click'),
    clickOutside: () => (docListeners.click || []).forEach(fn => fn({ target: { closest: () => null } })),
    clickInside: () => (docListeners.click || []).forEach(fn => fn({ target: header })),
    pressKey: key => (docListeners.keydown || []).forEach(fn => fn({ key })),
    scrollTo: y => { win.scrollY = y; (winListeners.scroll || []).forEach(fn => fn()); },
    state: () => ({
      menu: links.classList.contains('open'),
      burger: toggle.classList.contains('open'),
      expanded: toggle.getAttribute('aria-expanded'),
      label: toggle.getAttribute('aria-label'),
      scrolled: header.classList.contains('scrolled'),
    }),
  };
}

const INDEX_NAV = { sectionIds: ['features', 'quickstart', 'downloads'], scrolledOnScroll: true };
const MODELS_NAV = { sectionIds: [], scrolledOnScroll: false };

/* ============ B. 形态：单一实现 + 两页接线 ============ */

test('导航实现只有一份：main.js / models.js 不再自带 setupNav 与 isEmbedded', () => {
  assert.match(siteNavSrc, /function setupNav\(/, 'site-nav.js 应定义 setupNav');
  assert.match(siteNavSrc, /function isEmbedded\(/, 'site-nav.js 应自带 isEmbedded 短路');
  assert.match(siteNavSrc, /window\.GourdSiteNav\s*=\s*\{\s*setupNav\s*\}/, '应导出 window.GourdSiteNav');

  for (const [name, src] of [['main.js', mainSrc], ['models.js', modelsSrc]]) {
    assert.doesNotMatch(src, /function\s+setupNav\s*\(/, `${name} 不应再定义 setupNav（漂移源头）`);
    assert.doesNotMatch(src, /function\s+isEmbedded\s*\(/, `${name} 不应再定义 isEmbedded`);
    assert.doesNotMatch(src, /getElementById\('navToggle'\)|\$\('navToggle'\)/, `${name} 不应再自行抓取 navToggle`);
    assert.match(src, /window\.GourdSiteNav\.setupNav\(/, `${name} 应改为调用公共实现`);
  }
});

test('两页均加载 site-nav.js，且早于本页脚本（defer 下声明顺序即执行顺序）', () => {
  const check = (html, label, pageScript) => {
    const navAt = html.indexOf('src="js/site-nav.js"');
    const pageAt = html.indexOf(`src="js/${pageScript}"`);
    assert.ok(navAt >= 0, `${label} 必须加载 js/site-nav.js`);
    assert.ok(pageAt >= 0, `${label} 应加载 ${pageScript}`);
    assert.ok(
      navAt < pageAt,
      `${label} 的 site-nav.js 必须写在 ${pageScript} 之前，否则调用点会读到尚未定义的 GourdSiteNav`,
    );
    assert.match(html.slice(navAt, navAt + 90), /defer/, `${label} 的 site-nav.js 应保持 defer（DOM 就绪后才接线）`);
  };
  check(indexHtml, 'index.html', 'main.js');
  check(modelsHtml, 'models.html', 'models.js');
});

test('两页调用参数正确：index 接管滚动头部，models 不接管（其 header 常驻 scrolled）', () => {
  const idx = mainSrc.slice(mainSrc.indexOf('GourdSiteNav.setupNav'));
  assert.match(idx, /sectionIds:\s*\[[^\]]*'features'[^\]]*'quickstart'[^\]]*'downloads'[^\]]*\]/, 'index 保留三个页内区块高亮');
  assert.match(idx, /scrolledOnScroll:\s*true/, 'index 首屏透明，由滚动加 scrolled');

  const mdl = modelsSrc.slice(modelsSrc.indexOf('GourdSiteNav.setupNav'));
  assert.match(mdl, /sectionIds:\s*\[\s*\]/, 'models 导航项指向其它页面，不做页内锚点高亮');
  assert.match(mdl, /scrolledOnScroll:\s*false/, 'models 不得让公共实现接管滚动头部背景');

  // 前提本身也锁住：models.html 的 header 若不再写死 scrolled，上面的护栏就该重审
  assert.match(modelsHtml, /class="site-header scrolled"/, 'models.html 的 header 应仍为常驻 scrolled');
  assert.match(indexHtml, /class="site-header"\s+id="siteHeader"/, 'index.html 的 header 初始应无 scrolled');
});

/* ============ A. 行为：关闭路径与状态同步 ============ */

test('汉堡开合：展开同步 aria-expanded/aria-label，再点复位', () => {
  const p = mount({ nav: INDEX_NAV });
  assert.deepEqual(p.state(), { menu: false, burger: false, expanded: null, label: null, scrolled: false });

  p.openMenu();
  assert.deepEqual(p.state(), { menu: true, burger: true, expanded: 'true', label: '关闭菜单', scrolled: false });

  p.openMenu();
  assert.deepEqual(p.state(), { menu: false, burger: false, expanded: 'false', label: '打开菜单', scrolled: false });
});

test('关闭路径 1：点击任意导航项即收起 —— 四个项（含外链模型网关）逐个走真实点击链', () => {
  for (const [label, nav, headerClass] of [['index', INDEX_NAV, 'site-header'], ['models', MODELS_NAV, 'site-header scrolled']]) {
    const p = mount({ nav, headerClass });
    p.anchors.forEach((a, i) => {
      p.openMenu();
      assert.equal(p.state().menu, true, `${label} 第 ${i} 项展开前置条件失败`);
      a.fire('click'); // 真实绑定的 click 监听
      assert.equal(p.state().menu, false, `${label}：点击「${a.getAttribute('href')}」后菜单必须收起`);
      assert.equal(p.state().burger, false, `${label}：汉堡高亮应一并复位`);
      assert.equal(p.state().expanded, 'false', `${label}：aria-expanded 应复位`);
      assert.equal(p.state().label, '打开菜单', `${label}：aria-label 应复位`);
    });
  }
});

test('关闭路径 2：点击头部之外收起，点击头部之内不收起', () => {
  const outside = mount({ nav: INDEX_NAV });
  outside.openMenu();
  outside.clickInside();
  assert.equal(outside.state().menu, true, '头部内部点击不应收起');
  outside.clickOutside();
  assert.equal(outside.state().menu, false, '头部之外点击应收起');

  // 未展开时外部点击应幂等（不误改 aria 状态）
  const idle = mount({ nav: INDEX_NAV });
  idle.clickOutside();
  assert.deepEqual(idle.state(), { menu: false, burger: false, expanded: null, label: null, scrolled: false });
});

test('关闭路径 3：Esc 收起，无关按键不收起', () => {
  const p = mount({ nav: INDEX_NAV });
  p.openMenu();
  p.pressKey('a');
  assert.equal(p.state().menu, true, '无关按键不应收起');
  p.pressKey('Escape');
  assert.equal(p.state().menu, false, 'Esc 应收起菜单');
  assert.equal(p.state().expanded, 'false');
  assert.equal(p.state().label, '打开菜单');
});

test('models 页（不接管滚动）：header 常驻 scrolled 全程不被夺走', () => {
  const p = mount({ nav: MODELS_NAV, headerClass: 'site-header scrolled' });
  assert.equal(p.state().scrolled, true, '装载后应保留写死的 scrolled');
  assert.equal(p.scroll.length, 0, '无锚点且不接管滚动时不应挂 scroll 监听（避免空转回调）');

  p.openMenu();
  p.win.scrollY = 500; // 即便有残留 scroll 调用路径，也不能改 header 类
  p.anchors[0].fire('click');
  assert.equal(p.state().menu, false, '菜单仍能收起');
  assert.equal(p.state().scrolled, true, 'scrolled 仍应保留');
});

test('缺省参数（调用点漏传时）不得夺走常驻 scrolled：默认语义为“不接管”', () => {
  // 两个现有调用点都显式传参，所以这条专门盯默认值：新页漏写参数时不能默默改变行为。
  // 传 sectionIds 是为了逼出 scroll 监听（监听存在但不该动 header 类），才能测到默认分支。
  const p = mount({ headerClass: 'site-header scrolled', nav: { sectionIds: ['features'] } });
  assert.equal(p.scroll.length, 1, '前置：有锚点时应挂上一个 scroll 监听');
  assert.equal(p.state().scrolled, true, '装载后应保留写死的 scrolled');

  p.scrollTo(200); // 下滚
  assert.equal(p.state().scrolled, true, '缺省参数下下滚不得改 header 类');
  p.scrollTo(0); // scrollY<=8：若默认接管滚动，这一下会把 scrolled 剥掉
  assert.equal(p.state().scrolled, true, '缺省参数下滚动不得夺走 scrolled');
});

test('index 页（接管滚动）：>8px 加 scrolled，回顶移除', () => {
  const p = mount({ nav: INDEX_NAV });
  assert.equal(p.scroll.length, 1, '应注册且只注册一个 scroll 监听');
  assert.equal(p.state().scrolled, false, '首屏（scrollY=0）不应有 scrolled');

  p.scrollTo(200);
  assert.equal(p.state().scrolled, true, '下滚应加 scrolled');

  p.scrollTo(0);
  assert.equal(p.state().scrolled, false, '回到顶部应移除 scrolled');
});

test('外链导航项永不被页内高亮标记为 active', () => {
  const p = mount({ nav: INDEX_NAV });
  const ext = p.anchors[3];
  assert.equal(ext.classList.contains('active'), false, '「模型网关」外链初始不应 active');
  p.scrollTo(400);
  p.scrollTo(19996); // 触底分支：currentId 取最后一个 sectionId
  assert.equal(ext.classList.contains('active'), false, '滚动到底后外链依然不应 active');
  const hit = p.anchors.filter(a => a.classList.contains('active')).map(a => a.getAttribute('href'));
  assert.ok(hit.length === 0 || hit.every(h => h.startsWith('#')), `active 只应落在锚点项上，实得 ${JSON.stringify(hit)}`);
});

test('嵌入模式（<html> 带 is-embedded 标记）下完全短路，不注册任何监听', () => {
  const p = mount({ embedded: true, nav: INDEX_NAV });
  assert.equal(p.winListenerCount, 0, '嵌入模式不应注册 window 监听');
  assert.equal(p.docListenerCount, 0, '嵌入模式不应注册 document 监听');
  p.openMenu();
  assert.equal(p.state().menu, false, '嵌入模式汉堡按钮不应接线生效');
});

/* ============ C. 内联嵌入判定脚本：只认地址栏参数（iframe 不再参与） ============ */

// 提取页面中第一段无 src 的内联脚本（即嵌入判定脚本）
function extractInlineEmbedScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '页面应保留无 src 的内联嵌入判定脚本');
  return m[1];
}

// 执行真实的内联脚本；nested=true 模拟被 iframe 嵌套（window.self !== window.top），
// noUSP=true 模拟无 URLSearchParams 的老浏览器（走脚本自带的容错分支）。
function runEmbedScript(src, opts) {
  const o = opts || {};
  const htmlEl = { className: '' };
  const win = {};
  win.self = win;
  win.top = o.nested ? { parent: null } : win;
  const doc = { documentElement: htmlEl };
  const loc = { search: o.search === undefined ? '' : o.search };
  const USP = o.noUSP ? undefined : URLSearchParams;
  new Function('window', 'document', 'location', 'URLSearchParams', src)(win, doc, loc, USP);
  return /\bis-embedded\b/.test(' ' + htmlEl.className);
}

const PAGES = [['index.html', indexHtml], ['models.html', modelsHtml]];

test('内联脚本只认地址栏 embed 参数：无参数默认展示，参数真值隐藏、显式否定保持展示', () => {
  const cases = [
    ['', false], ['?other=1', false],
    ['?embed', true], ['?embed=1', true], ['?embed=true', true], ['?embed=TRUE', true], ['?x=1&embed=1', true],
    ['?embed=0', false], ['?embed=false', false], ['?embed=FALSE', false],
  ];
  for (const [label, html] of PAGES) {
    const src = extractInlineEmbedScript(html);
    for (const [search, want] of cases) {
      const got = runEmbedScript(src, { search });
      assert.equal(got, want, `${label}${search || '(无参数)'} → 应${want ? '隐藏' : '展示'}导航，实得${got ? '隐藏' : '展示'}`);
    }
  }
});

test('iframe 嵌套不再影响导航展示（本次改造核心）：嵌套+无参数照常展示，嵌套+显式参数仍受控', () => {
  for (const [label, html] of PAGES) {
    const src = extractInlineEmbedScript(html);
    assert.equal(runEmbedScript(src, { nested: true, search: '' }), false,
      `${label}：被 iframe 嵌套且无参数时，导航必须照常展示（不再自动隐藏）`);
    assert.equal(runEmbedScript(src, { nested: true, search: '?embed=1' }), true,
      `${label}：嵌套 + 显式 ?embed=1 时才隐藏`);
    assert.equal(runEmbedScript(src, { nested: true, search: '?embed=0' }), false,
      `${label}：嵌套 + 显式 ?embed=0 保持展示`);
  }
});

test('两页内联脚本同源一致、前置在 <head> 内，且不含任何 iframe 判定残留', () => {
  const srcs = PAGES.map(([label, html]) => [label, extractInlineEmbedScript(html)]);
  const normalize = s => s.replace(/\r\n/g, '\n');
  assert.equal(normalize(srcs[0][1]), normalize(srcs[1][1]), '两页嵌入判定脚本必须逐字一致（防漂移）');

  for (const [label, html] of PAGES) {
    const at = html.indexOf('<script>');
    const headEnd = html.indexOf('</head>');
    assert.ok(at >= 0 && at < headEnd, `${label} 内联脚本必须前置在 <head> 内（否则导航条会先渲染再消失）`);
  }
  for (const [label, src] of srcs) {
    assert.doesNotMatch(src, /window\.self|window\.top|frameElement/, `${label}：不得残留任何 iframe 自动判定`);
  }
});

test('标记类名跨处一致：内联脚本写入 is-embedded，site-nav.js 与 CSS 同步消费', () => {
  for (const [label, html] of PAGES) {
    assert.match(extractInlineEmbedScript(html), /className \+= ' is-embedded'/, `${label} 应写 is-embedded 标记`);
  }
  assert.match(siteNavSrc, /is-embedded/, 'site-nav.js 应短路消费该标记');
  assert.match(readSite('css', 'styles.css'), /\.is-embedded \.site-header/, 'styles.css 应消费该标记隐藏导航');
  assert.match(readSite('css', 'models.css'), /\.is-embedded \.models-page/, 'models.css 应消费该标记收敛留白');
});

test('老浏览器兜底：无 URLSearchParams 时保持默认展示，脚本不得整体抛错', () => {
  for (const [label, html] of PAGES) {
    const src = extractInlineEmbedScript(html);
    assert.equal(runEmbedScript(src, { search: '?embed=1', noUSP: true }), false,
      `${label}：无 URLSearchParams 时应保持默认展示（容错分支）`);
  }
});

/* ============ 卫生 ============ */

test('site-nav.js 行尾统一、无 jQuery 依赖、无残留变异标记', () => {
  const crlfCount = (siteNavSrc.match(/\r\n/g) || []).length;
  const lfCount = (siteNavSrc.match(/\n/g) || []).length;
  assert.ok(
    crlfCount === 0 || crlfCount === lfCount,
    `site-nav.js 行尾不应混用（CRLF=${crlfCount} / 总 LF=${lfCount}）`,
  );
  assert.ok(!siteNavSrc.includes('MUTANT'), '不应残留变异标记');
  assert.doesNotMatch(siteNavSrc, /\bjQuery\b|\$\(/, '官网脚本不使用 jQuery');
});
