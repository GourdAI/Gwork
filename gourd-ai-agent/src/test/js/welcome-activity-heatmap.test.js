/* 主工作区「活跃热力图」卡片契约测试。
 *
 * 覆盖三层，防止改动回退：
 *  1) 结构层：chat.html 的卡片骨架 + hero 紧凑 class、app-bootstrap 脚本注册顺序；
 *  2) 共享层：usage-stats.css 的 .usage-heat-* 不再被 #usageView 作用域锁死、
 *     app-settings-usage.js 不再自带第二份网格渲染（两页共用 app-heatmap.js）；
 *  3) 行为层：沙箱执行 app-heatmap.js 的真实 renderGrid —— 分档公式、future 占位、
 *     title 转义、图例 0..4 档、列数推导（周数），以及欢迎页模块的显隐/保留旧图语义。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const heatmapJs = readStatic('js', 'app-heatmap.js');
const welcomeJs = readStatic('js', 'app-welcome-activity.js');
const chatHtml = readStatic('chat.html');
const appCss = readStatic('css', 'app.css');
const usageCss = readStatic('css', 'usage-stats.css');
const settingsUsageJs = readStatic('js', 'app-settings-usage.js');
const bootstrapJs = readStatic('js', 'app-bootstrap.js');
const appUiJs = readStatic('js', 'app-ui.js');

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `未找到结束标记: ${endMarker}`);
  return source.slice(start, end);
}

/* ── 沙箱：加载 app-heatmap.js，注入最小 window/i18n 环境 ── */
function loadHeatmap(opts) {
  opts = opts || {};
  const translations = opts.translations || {};
  const gourdI18n = {
    t(key, args) {
      if (Object.prototype.hasOwnProperty.call(translations, key)) {
        let s = translations[key];
        (args || []).forEach((v, i) => { s = s.replace('{' + i + '}', String(v)); });
        return s;
      }
      return key;
    },
    getLocale() { return opts.locale || null; }
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    GourdI18n: gourdI18n,                 // 浏览器里是全局；源码按全局引用
    window: { GourdI18n: gourdI18n }
  };
  vm.createContext(context);
  vm.runInContext(heatmapJs, context, { filename: 'app-heatmap.js' });
  return context.window.GourdHeatmap;
}

/* 构造与后端同构的窗口：weeks 周 × 7 天，以周日为列首 */
function makeWindow(days, fill) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const item = fill(i);
    out.push(item);
  }
  return out;
}
function isoDate(offsetFromToday) {
  const d = new Date();
  d.setDate(d.getDate() + offsetFromToday);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/* 剥掉 CSS 注释：只留真正生效的声明。
 *
 * 【为何必须做——本会话第三次坏在同一个坑上】
 * 变异 M8（删掉 `.usage-heat-tip-k` 的 min-width:0）**存活**了：
 * 我的断言 /min-width:\s*0/ 匹配到了旁边那段解释“为何需要 min-width:0”的注释。
 * 同一个毛病已出现三次（JS 接线断言命中注释 / notation 断言命中注释 / 这里）。
 * 规矩：**任何基于源码文本的断言，先剥注释再断言**，否则测的是文档不是代码。 */
function stripCssComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '');
}

/* 从渲染后的 HTML 中提取“非 future 格子”（带 data-level 的那些）的属性快照。
 *
 * 【为何不用 `/class="usage-heat-cell" data-level=/` 这种写法】
 * 它把“class 后面紧跟 data-level”当成了契约 —— 实际上 HTML 属性顺序不属于契约，
 * 本轮给格子补 role="img"（无障碍必需）时 7 个断言集体变红，
 * 全都是“行为没变、断言死了”。这里按语义取标签再解析属性，与顺序解耦。 */
function heatCells(html) {
  const out = [];
  const re = /<div\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (!/class="[^"]*\busage-heat-cell\b/.test(attrs)) continue;   // 只看格子
    if (!/\bdata-level=/.test(attrs)) continue;                       // 排除 future 占位格
    const level = (attrs.match(/data-level="(\d)"/) || [])[1];
    const role = (attrs.match(/role="([^"]*)"/) || [])[1];
    const date = (attrs.match(/data-date="([^"]*)"/) || [])[1];
    out.push({ level, role, date, attrs });
  }
  return out;
}

test('结构：chat.html 含活跃卡骨架（卡片/内容容器），hero 带 welcome-compact', () => {
  assert.ok(chatHtml.includes('id="welcomeActivityCard"'), '缺少卡片容器');
  assert.ok(chatHtml.includes('id="welcomeActivityBody"'), '缺少内容容器');
  // 首屏不得闪空框：骨架必须初始隐藏，成功拿到数据后才显示
  assert.ok(chatHtml.includes('id="welcomeActivityCard" style="display:none"'), '卡片骨架应初始 display:none');
  assert.ok(chatHtml.includes('class="welcome-view welcome-compact"'), 'hero 未加紧凑 class');
  const card = sliceBetween(chatHtml, 'id="welcomeActivityCard"', '</div>');
  // 欢迎页紧凑态：卡内不得再有标题行/图例容器（视觉重心让给输入框与品牌标识）
  assert.ok(!card.includes('welcome-activity-title'), '卡内不应再有标题行');
  assert.ok(!card.includes('settings.usage.heatmap_title'), '卡内不应再引用 heatmap_title');
});

test('结构：欢迎页卡无标题行，且 CSS 不再定义 .welcome-activity-title', () => {
  assert.ok(!chatHtml.includes('welcome-activity-title'), 'chat.html 不应残留标题节点');
  assert.ok(!appCss.includes('.welcome-activity-title'), 'app.css 不应残留标题样式');
  // 卡壳去边框/底色：退为输入框上方的安静背景条
  const cardCss = sliceBetween(appCss, '.welcome-activity-card {', '}');
  assert.ok(!cardCss.includes('border:'), '卡壳不应再有边框');
  assert.ok(!cardCss.includes('background:'), '卡壳不应再有底色');
});

test('结构：活跃卡位于 hero（标题）与输入框之间', () => {
  const sub = chatHtml.indexOf('id="welcomeTitle"');
  const card = chatHtml.indexOf('id="welcomeActivityCard"');
  const input = chatHtml.indexOf('id="welcomeDropZone"');
  assert.ok(sub >= 0 && card > sub, '活跃卡应在标题之后');
  assert.ok(input >= 0 && card < input, '活跃卡应在输入框之前');
  assert.ok(!chatHtml.includes('class="welcome-sub"'), '副标题已按需求移除，不应残留');
});

test('结构：app-bootstrap 注册 app-heatmap.js 与 app-welcome-activity.js 且顺序正确', () => {
  const iHeat = bootstrapJs.indexOf("'/js/app-heatmap.js'");
  const iWelcome = bootstrapJs.indexOf("'/js/app-welcome-activity.js'");
  assert.ok(iHeat >= 0 && iWelcome >= 0, '两个脚本必须注册');
  assert.ok(iHeat < iWelcome, '热力图共享组件应先于欢迎页卡片加载');
  // 依赖链：app-welcome-activity 需要先有 app-heatmap
  assert.ok(bootstrapJs.indexOf("'/js/app-context.js'") < iHeat, '共享组件应在上下文模块之后（保持既有相对顺序不变）');
});

test('结构：回欢迎页时接线刷新（switchToWelcomeMode → refreshWelcomeActivity）', () => {
  assert.ok(appUiJs.includes('refreshWelcomeActivity'), 'app-ui.js 未接线刷新');
  const fn = sliceBetween(appUiJs, 'function switchToWelcomeMode()', '/* ===== Auto-resize ===== */');
  assert.ok(fn.includes('refreshWelcomeActivity'), '刷新应发生在切回欢迎页路径上');
});

test('共享层：usage-stats.css 的 .usage-heat-* 不再被 #usageView 锁死（两页共用）', () => {
  assert.ok(!usageCss.includes('#usageView .usage-heat-'), '.usage-heat-* 不应再带 #usageView 前缀');
  for (const sel of ['.usage-heat-grid', '.usage-heat-cell', '.usage-heat-legend', '.usage-heat-empty', '.usage-heat-legend-cell', '.usage-heat-wrap']) {
    assert.ok(usageCss.includes(sel + ' '), `缺少共享选择器 ${sel}`);
  }
  // 分档配色必须保留 0..4 五档（组件 title 分档依赖）
  for (let lv = 0; lv <= 4; lv++) {
    assert.ok(usageCss.includes(`.usage-heat-cell[data-level="${lv}"]`), `缺少 data-level=${lv} 配色`);
  }
});

test('共享层：使用统计页不再自带第二份网格渲染，改为委托 GourdHeatmap', () => {
  assert.ok(!settingsUsageJs.includes("'<div class=\"usage-heat-grid\""), '不应残留本地网格渲染');
  assert.ok(!settingsUsageJs.includes('function fmtDateMd('), '本地 fmtDateMd 应已删除（共享组件内已有）');
  assert.ok(settingsUsageJs.includes('window.GourdHeatmap.renderGrid'), '应委托共享组件');
  assert.ok(settingsUsageJs.includes('{ months: true }'), '统计页应开启月份时间轴（与欢迎页同算法）');
});

test('共享层：欢迎页模块只消费共享组件，不复制网格拼接', () => {
  assert.ok(!welcomeJs.includes('usage-heat-grid'), '欢迎页模块不得自带网格拼接');
  assert.ok(welcomeJs.includes('window.GourdHeatmap.renderGrid'), '欢迎页应调用共享组件');
  assert.ok(!welcomeJs.includes('#usageView'), '欢迎页不应依赖使用统计页容器');
});

test('行为：renderGrid 支持 legend:false —— 不输出图例且套紧凑 class（默认仍带图例）', () => {
  const H = loadHeatmap();
  const heatmap = makeWindow(14, (i) => ({ date: isoDate(i - 13), tokens: i + 1, rounds: 1, future: false }));
  const withLegend = H.renderGrid(heatmap);
  assert.ok(withLegend.includes('usage-heat-legend'), '默认应带图例');
  assert.ok(!withLegend.includes('usage-heat-compact'), '默认不应套紧凑 class');
  const compact = H.renderGrid(heatmap, { legend: false });
  assert.ok(!compact.includes('usage-heat-legend'), 'legend:false 不得输出图例');
  assert.ok(compact.includes('usage-heat-compact'), 'legend:false 应套紧凑 class');
  assert.ok(compact.includes('usage-heat-grid'), '网格本体仍应输出');
  // 格子数不受开关影响
  assert.equal(heatCells(compact).length, 14);
});

test('行为：renderGrid 输出合法网格 —— 列数=周数、格子数=天数、图例 5 档', () => {
  const H = loadHeatmap();
  const heatmap = makeWindow(182, (i) => ({
    date: isoDate(i - 181), tokens: i * 10, rounds: i, future: false
  }));
  const html = H.renderGrid(heatmap);
  assert.match(html, /class="usage-heat-grid" style="grid-template-columns:repeat\(26,1fr\)"/);
  // 182 个格子（全部非 future）
  assert.equal(heatCells(html).length, 182);
  // 每格必须带 role="img"：裸 div 的 aria-label 虽然能进 AX 树（实测 role=generic），
  // 但 generic 容器在多数读屏器里不会被当“有名字的对象”报读；且不能用 tabindex
  // 把 371 格刷进 Tab 序列（键盘导航会彻底瘫痪）。
  const cells = heatCells(html);
  assert.ok(cells.every(c => c.role === 'img'), '每个格子应带 role="img"（无障碍语义）');
  assert.ok(!/usage-heat-cell[^>]*tabindex=/.test(html), '格子不得加 tabindex（371 个 Tab 停留点会毁掉键盘导航）');
  // 图例：5 个 legend-cell（0..4），带少/多文案 key
  assert.equal((html.match(/usage-heat-legend-cell" data-level="/g) || []).length, 5);
  assert.ok(html.includes('settings.usage.heat_less') && html.includes('settings.usage.heat_more'));
});

test('行为：分档为窗口内相对口径（max → level 4；零 → level 0）', () => {
  const H = loadHeatmap();
  const heatmap = [
    { date: '2026-03-01', tokens: 0, rounds: 0, future: false },
    { date: '2026-03-02', tokens: 25, rounds: 1, future: false },   // 25/100*4=1 → lv1
    { date: '2026-03-03', tokens: 50, rounds: 2, future: false },   // → lv2
    { date: '2026-03-04', tokens: 100, rounds: 4, future: false }   // max → lv4
  ];
  const html = H.renderGrid(heatmap);
  const levels = heatCells(html).map(c => c.level);
  assert.deepEqual(levels, ['0', '1', '2', '4']);
});

test('行为：未来日渲染为空占位格（与零活跃同色，不参与分档）', () => {
  const H = loadHeatmap();
  const heatmap = [
    { date: '2026-03-01', tokens: 9, rounds: 1, future: false },
    { date: '2026-03-02', tokens: 0, rounds: 0, future: true }
  ];
  const html = H.renderGrid(heatmap);
  assert.equal((html.match(/usage-heat-empty/g) || []).length, 1);
  // 未来日不得输出 title（它没有可展示的数据）
  assert.ok(!/usage-heat-empty"[^>]*title=/.test(html), '未来日不应带悬停提示');
  // 也不能被读屏器当成“有名字的图形”报读：它既无数据也无标签，
  // 必须显式 aria-hidden（否则 371 格里每天未来的格都是一个无名停靠点）。
  const emptyTag = html.match(/<div class="usage-heat-cell usage-heat-empty"[^>]*>/);
  assert.ok(emptyTag, '应存在未来日占位格');
  assert.match(emptyTag[0], /aria-hidden="true"/, '未来日必须 aria-hidden（无信息可报读）');
  assert.ok(!/aria-label/.test(emptyTag[0]), '未来日不得带 aria-label（没数据可读）');
});

test('行为：悬停数据写入 data-* 与 aria-label（不再用原生 title）', () => {
  const H = loadHeatmap({
    locale: 'en-US',
    translations: {
      'settings.usage.tip_tasks': 'Tasks',
      'settings.usage.tip_tokens': 'Tokens used'
    }
  });
  const heatmap = [{ date: '2026-09-22', tokens: 12345, rounds: 7, sessions: 3, future: false }];
  const html = H.renderGrid(heatmap);
  // 用户点名：原生 title 太丑 → 改为自定义浮层，格子只承载数据
  assert.ok(!/\stitle="/.test(html), '不得再输出原生 title 属性，实际: ' + html);
  assert.ok(html.includes('data-date="2026-09-22"'), '应带 data-date');
  assert.ok(html.includes('data-tokens="12345"'), '应带 data-tokens');
  assert.ok(html.includes('data-tasks="3"'), '应带 data-tasks（当天任务数）');
  // 去掉 title 不能让读屏用户失去信息，aria-label 必须带完整文案
  const m = html.match(/aria-label="([^"]*)"/);
  assert.ok(m, '应存在 aria-label');
  assert.ok(m[1].includes('Tasks 3'), 'aria-label 应含任务数，实际: ' + m[1]);
  assert.ok(m[1].includes('Tokens used 12.3K'), 'aria-label 应含按 locale 紧凑化的 token，实际: ' + m[1]);
});

test('行为：tokens 为 0 时保持 0 档（不因 maxTok>0 被抬到 1 档）', () => {
  const H = loadHeatmap();
  const heatmap = [
    { date: '2026-03-01', tokens: 0, rounds: 0, future: false },
    { date: '2026-03-02', tokens: 999, rounds: 3, future: false }
  ];
  const html = H.renderGrid(heatmap);
  const levels = heatCells(html).map(c => c.level);
  assert.deepEqual(levels, ['0', '4']);
});

test('行为：欢迎页模块语义 —— 全零隐藏、失败无声、成功显示', () => {
  // 该模块依赖 jQuery($)/document/window，用最小替身执行源码：
  // $.ajax 返回可链式 jqXHR；用 lastAjax.done()/fail() 同步触发回调。
  const sandbox = {};
  let lastAjax = null;
  const context = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById(id) { return sandbox[id] || null; },
      addEventListener() {}
    },
    window: { GourdHeatmap: { renderGrid: () => '<div class="usage-heat-grid"></div>' } }
  };
  const card = { style: { display: 'none' } };
  const body = { innerHTML: '' };
  sandbox['welcomeActivityCard'] = card;
  sandbox['welcomeActivityBody'] = body;
  context.$ = {
    ajax(opts) {
      let doneCb = null, failCb = null, alwaysCb = null;
      const jq = {
        done(cb) { doneCb = cb; return jq; },
        fail(cb) { failCb = cb; return jq; },
        always(cb) { alwaysCb = cb; return jq; },
        abort() {}
      };
      lastAjax = {
        opts,
        done(resp) { doneCb && doneCb(resp); alwaysCb && alwaysCb(); },
        fail() { failCb && failCb({}, 'error'); alwaysCb && alwaysCb(); }
      };
      return jq;
    }
  };

  vm.createContext(context);
  vm.runInContext(welcomeJs, context, { filename: 'app-welcome-activity.js' });

  assert.equal(typeof context.window.refreshWelcomeActivity, 'function', '应暴露刷新函数');

  // 全零窗口：隐藏
  const zeroWin = makeWindow(7, (i) => ({ date: isoDate(i - 6), tokens: 0, rounds: 0, future: false }));
  context.window.refreshWelcomeActivity();
  assert.ok(lastAjax.opts.url.includes('/web/chat/usage/stats'), '应请求使用统计接口');
  lastAjax.done({ code: 200, data: { heatmap: zeroWin } });
  assert.equal(card.style.display, 'none', '全零窗口应隐藏卡片');

  // 有数据：显示
  const busyWin = makeWindow(7, (i) => ({ date: isoDate(i - 6), tokens: i + 1, rounds: 1, future: false }));
  context.window.refreshWelcomeActivity();
  lastAjax.done({ code: 200, data: { heatmap: busyWin } });
  assert.notEqual(card.style.display, 'none', '有数据应显示卡片');
  assert.ok(body.innerHTML.includes('usage-heat-grid'), '应渲染网格');

  // 请求失败：已有内容时保留旧图（不清空、不隐藏）
  const kept = body.innerHTML;
  context.window.refreshWelcomeActivity();
  lastAjax.fail();
  assert.equal(body.innerHTML, kept, '失败时不应擦除已渲染内容');
  assert.notEqual(card.style.display, 'none', '失败时已有旧图应保持可见（不得整卡隐藏）');
});

/* ── 增强 harness：记录全部 ajax、可触发 i18n 事件、renderGrid 带序号以便区分多次渲染 ── */
function makeWelcomeHarness() {
  const sandbox = {};
  const ajaxes = [];
  const renderOpts = [];
  let renderCount = 0;
  const listeners = {};
  const context = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById(id) { return sandbox[id] || null; },
      addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); }
    },
    window: {
      GourdHeatmap: {
        renderGrid(h, opts) { renderOpts.push(opts); return '<div class="usage-heat-grid" data-n="' + (++renderCount) + '"></div>'; }
      }
    }
  };
  const card = { style: { display: 'none' } };
  const body = { innerHTML: '' };
  sandbox['welcomeActivityCard'] = card;
  sandbox['welcomeActivityBody'] = body;
  context.$ = {
    ajax(opts) {
      let doneCb = null, failCb = null, alwaysCb = null;
      const rec = { opts, aborted: false };
      const jq = {
        done(cb) { doneCb = cb; return jq; },
        fail(cb) { failCb = cb; return jq; },
        always(cb) { alwaysCb = cb; return jq; },
        abort() { rec.aborted = true; }
      };
      rec.done = (resp) => { doneCb && doneCb(resp); alwaysCb && alwaysCb(); };
      rec.fail = () => { failCb && failCb({}, 'error'); alwaysCb && alwaysCb(); };
      ajaxes.push(rec);
      return jq;
    }
  };
  vm.createContext(context);
  vm.runInContext(welcomeJs, context, { filename: 'app-welcome-activity.js' });
  // 排干模块自举的首次请求（脚本求值即触发 initialLoad），使后续索引可预测；
  // 用 fail 排干以保持 lastSuccess=false 的首屏态，不污染后续用例的显隐断言
  ajaxes[0].fail();
  return {
    context, ajaxes, card, body, renderOpts,
    fireLocale() { (listeners['i18n:localeChanged'] || []).forEach(cb => cb()); }
  };
}
const busyWin7 = () => makeWindow(7, (i) => ({ date: isoDate(i - 6), tokens: i + 1, rounds: 1, future: false }));

test('行为：迟到响应被 serial 守卫丢弃，不得覆盖在途新请求的结果', () => {
  const h = makeWelcomeHarness();
  const base = h.ajaxes.length;
  h.context.window.refreshWelcomeActivity();          // 请求 A
  h.context.window.refreshWelcomeActivity();          // 请求 B（A 应被 abort）
  assert.equal(h.ajaxes.length, base + 2, '应发出两次请求');
  const A = h.ajaxes[base], B = h.ajaxes[base + 1];
  assert.equal(A.aborted, true, '重入时旧请求应被 abort');
  A.done({ code: 200, data: { heatmap: busyWin7() } });   // A 迟到到达
  assert.equal(h.body.innerHTML, '', '迟到的旧响应不得渲染');
  assert.equal(h.card.style.display, 'none', '迟到响应不得改变显隐');
  B.done({ code: 200, data: { heatmap: busyWin7() } });   // B 正常到达
  assert.ok(h.body.innerHTML.includes('usage-heat-grid'), '在途请求应正常渲染');
  assert.notEqual(h.card.style.display, 'none');
  // 欢迎页必须关闭图例（紧凑态）
  assert.equal(h.renderOpts[h.renderOpts.length - 1].legend, false, '欢迎页应传 legend:false');
});

test('行为：非 200 业务码即使带 data 也不渲染（按失败处理）', () => {
  const h = makeWelcomeHarness();
  h.context.window.refreshWelcomeActivity();
  h.ajaxes[h.ajaxes.length - 1].done({ code: 500, data: { heatmap: busyWin7() } });
  assert.equal(h.body.innerHTML, '', '错误码不得渲染数据');
  assert.equal(h.card.style.display, 'none', '首屏失败应整卡隐藏');
});

test('行为：语言切换事件触发重渲染（仅卡片可见时）', () => {
  const h = makeWelcomeHarness();
  h.context.window.refreshWelcomeActivity();
  h.ajaxes[h.ajaxes.length - 1].done({ code: 200, data: { heatmap: busyWin7() } });
  const before = h.ajaxes.length;
  h.fireLocale();
  assert.equal(h.ajaxes.length, before + 1, '可见时语言切换应重拉数据');
  // 隐藏态（全零）下语言切换不应发请求
  const h2 = makeWelcomeHarness();
  h2.context.window.refreshWelcomeActivity();
  h2.ajaxes[h2.ajaxes.length - 1].done({ code: 200, data: { heatmap: makeWindow(7, () => ({ date: isoDate(0), tokens: 0, rounds: 0, future: false })) } });
  const n2 = h2.ajaxes.length;
  h2.fireLocale();
  assert.equal(h2.ajaxes.length, n2, '隐藏态语言切换不应发请求');
});

test('行为：悬停载体属性必须完整转义（引号/尖括号不得截断属性）', () => {
  const H = loadHeatmap({
    locale: 'en-US',
    translations: {
      'settings.usage.tip_tasks': '<b x="1"> & {1}',
      'settings.usage.tip_tokens': 'Tok'
    }
  });
  const html = H.renderGrid([{ date: '2026-09-22', tokens: 5, rounds: 2, sessions: 1, future: false }]);
  const m = html.match(/aria-label="([^"]*)"/);
  assert.ok(m, '应存在 aria-label');
  assert.ok(m[1].includes('&lt;b x=&quot;1&quot;'), '尖括号与引号必须转义，实际: ' + m[1]);
  assert.ok(m[1].includes('&amp;'), '& 必须转义');
  assert.ok(!m[1].includes('<b'), '不得残留裸尖括号');
  // data-date 来自后端，同样不能出现裸特殊字符
  const html2 = H.renderGrid([{ date: '2026-09-"22', tokens: 1, sessions: 0, future: false }]);
  assert.ok(!/data-date="[^"]*"22/.test(html2), 'data-date 必须转义引号');
});

test('形态：紧凑变体必须是方形格（不得压扁成长条）', () => {
  // 用户截图点名：主界面活力图「成长条了」。根因 = 紧凑变体曾用 aspect-ratio: 2/1
  // 把格高压半，26 列铺满 680px 时每格成为横向长条，失去热力图的可读形态。
  const compactRule = usageCss.match(/\.usage-heat-compact \.usage-heat-cell \{[^}]*\}/);
  assert.ok(compactRule, '缺少紧凑变体格规则');
  assert.match(compactRule[0], /aspect-ratio:\s*1 \/ 1/, '紧凑变体必须保持方形格');
  assert.doesNotMatch(compactRule[0], /aspect-ratio:\s*2 \/ 1/, '不得回退 2:1 长条形态');
});

test('行为：列数由窗口长度推导（7 天=1 列、14 天=2 列、空=1 列），不得写死', () => {
  const H = loadHeatmap();
  const one = H.renderGrid(makeWindow(7, (i) => ({ date: isoDate(i - 6), tokens: 1, rounds: 1, future: false })));
  assert.match(one, /repeat\(1,1fr\)/, '7 天窗口应为 1 列');
  const two = H.renderGrid(makeWindow(14, (i) => ({ date: isoDate(i - 13), tokens: 1, rounds: 1, future: false })));
  assert.match(two, /repeat\(2,1fr\)/, '14 天窗口应为 2 列');
  const empty = H.renderGrid([]);
  assert.match(empty, /repeat\(1,1fr\)/, '空窗口应回退 1 列而非 0 列');
});

/* ── 月份时间轴 + 固定格宽（用户点名：整体缩小 + 加时间轴；53 周全年窗口） ── */
/* 固定窗口：startSunday（周日）起 weeks 周；月份首列由日期精确推算。
   26w@2026-01-04：Jan=0, Feb=4, Mar=8, Apr=12, May=16, Jun=21, Jul=25
   53w@2025-09-21：Sep=0, Oct=1, Nov=5, Dec=10, Jan=14, Feb=19, Mar=23,
                   Apr=27, May=31, Jun=36, Jul=40, Aug=44, Sep=49 */
function fixedWindow(startSundayIso, weeks, futureTail) {
  const start = Date.UTC(...startSundayIso.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const out = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start + i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    out.push({ date: iso, tokens: (i % 5) + 1, rounds: 1, future: futureTail > 0 && i >= weeks * 7 - futureTail });
  }
  return out;
}
const fixedWindow26w = (futureTail) => fixedWindow('2026-01-04', 26, futureTail || 0);
const fixedWindow53w = (futureTail) => fixedWindow('2025-09-21', 53, futureTail || 0);

/* 月份轴 span 新形态：<span style="left:X%">Name</span>（让位/回拉后不再需要 translateX 锚） */
function monthSpans(html) {
  return [...html.matchAll(/<span style="left:([\d.]+)%">([^<]*)<\/span>/g)].map(m => ({ left: Number(m[1]), name: m[2] }));
}
const MIN_GAP_COLS = 3.0;   // 与 app-heatmap.js renderMonths 的 MIN_GAP 互为契约
const LABEL_W_COLS = 2.6;   // 同上 LABEL_W

test('行为：months:true 输出月份时间轴（默认不输出）；53 周窗口铺满 12 个月标签', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const heatmap = fixedWindow53w(0);
  const plain = H.renderGrid(heatmap);
  assert.ok(!plain.includes('usage-heat-months'), '不传 months 不得输出月份轴（组件默认形态）');
  const withMonths = H.renderGrid(heatmap, { months: true });
  assert.ok(withMonths.includes('class="usage-heat-months"'), 'months:true 应输出月份轴容器');
  const spans = monthSpans(withMonths);
  assert.equal(spans.length, 12, '53 周跨 13 个月、前导残月不出标签 → 12 个标签，实际 ' + spans.length);
  assert.deepEqual(spans.map(s => s.name),
    ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'],
    '月份名应走 Intl(en-US) 短名且完整月份一个不丢');
  // 锚点=月首个周日列：首标签 Oct 落在 10-05（第 2 列），间距≥MIN_GAP，末标签右缘收进容器
  const cols = spans.map(s => Math.round(s.left / 100 * 53 * 10) / 10);
  assert.equal(cols[0], 2, '首标签应锚定该月首个周日列（2025-10-05 = 第 2 列）');
  for (let i = 1; i < cols.length; i++) {
    assert.ok(cols[i] - cols[i - 1] >= MIN_GAP_COLS - 0.05, `标签${i - 1}→${i} 间距 ${cols[i] - cols[i - 1]} 列应 ≥ ${MIN_GAP_COLS}`);
  }
  assert.ok(cols[cols.length - 1] + LABEL_W_COLS <= 53, '末标签右缘不得超出末列');
});

test('行为：前导残月（放不下一个标签）不出标签，轴中完整月份一个不丢', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  // 2026-09-20 收尾的 26 周：Mar 仅占首列 3 天（残月），Apr 首个周日=第 1 列，间距 1 < MIN_GAP
  // → Mar 标签舍去（格子照常渲染）；其余完整月份锚定各自首个周日，间距天然 ≥4 列
  const heatmap = fixedWindow('2026-03-29', 26, 0);
  const spans = monthSpans(H.renderGrid(heatmap, { months: true }));
  assert.deepEqual(spans.map(s => s.name), ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'], '6 个完整月份一个都不能丢');
  const cols = spans.map(s => Math.round(s.left / 100 * 26 * 10) / 10);
  assert.equal(cols[0], 1, 'Apr 应锚定首个周日 2026-04-05（第 1 列）');
  for (let i = 1; i < cols.length; i++) {
    assert.ok(cols[i] - cols[i - 1] >= MIN_GAP_COLS - 0.05, '间距应 ≥ MIN_GAP，实际 ' + (cols[i] - cols[i - 1]));
  }
});

test('行为：末标签回拉不超容器且连锁保障间距', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  // 收尾周日贴月末：末月首列≈52（> 53−2.6），必须被回拉
  const heatmap = fixedWindow('2025-10-05', 53, 0);
  const spans = monthSpans(H.renderGrid(heatmap, { months: true }));
  const cols = spans.map(s => Math.round(s.left / 100 * 53 * 10) / 10);
  assert.ok(cols[cols.length - 1] + LABEL_W_COLS <= 53, '末标签右缘应收进容器');
  for (let i = 1; i < cols.length; i++) {
    assert.ok(cols[i] - cols[i - 1] >= MIN_GAP_COLS - 0.05, '回拉后仍应保障间距');
  }
});

test('行为：月份轴跳过 future 日、同月只出一个标签', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const heatmap = fixedWindow26w(6);   // 末 6 天（7 月初）为 future
  const html = H.renderGrid(heatmap, { months: true });
  const names = monthSpans(html).map(s => s.name);
  assert.ok(!names.includes('Jul'), '末月全为 future 时不得输出该月标签');
  assert.equal(names.length, 6, '应只剩 6 个标签');
  // 同月多天只出一个标签：单月窗口
  const oneMonth = makeWindow(14, (i) => ({ date: '2026-03-' + String(i + 1).padStart(2, '0'), tokens: 1, rounds: 1, future: false }));
  const one = H.renderGrid(oneMonth, { months: true });
  assert.equal((one.match(/<span style=/g) || []).length, 1, '同月窗口应只输出 1 个标签');
});

test('行为：列模板始终 1fr 拉伸（固定格宽形态已移除，欢迎页随输入框同宽铺满）', () => {
  const H = loadHeatmap();
  const heatmap = fixedWindow26w(0);
  assert.match(H.renderGrid(heatmap, { fixed: true }), /grid-template-columns:repeat\(26,1fr\)/, '历史 fixed 入参不得再切回固定格宽');
  assert.match(H.renderGrid(heatmap), /grid-template-columns:repeat\(26,1fr\)/, '默认 1fr 拉伸');
  assert.ok(!heatmapJs.includes('--heat-cell'), '固定格宽变量应已移除');
});

test('行为：year:true 把 26 周后端窗口补齐到 53 周（旧 jar 兼容），月份轴铺满 12 个', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const half = fixedWindow('2026-03-29', 26, 0);   // 模拟旧 jar 返回的 26 周
  assert.equal(half.length, 182);
  const padded = H.renderGrid(half, { legend: false, months: true, fixed: true, year: true });
  // 补齐到 53 周 = 371 格
  assert.equal(heatCells(padded).length, 371, '26 周应被补齐到 53 周(371 格)');
  assert.match(padded, /repeat\(53,1fr\)/, '列模板应为 53 列');
  const spans = monthSpans(padded);
  assert.equal(spans.length, 12, '补齐后月份轴应铺满 12 个标签（前导残月不出），实际 ' + spans.length);
  // 补齐的前导格是零活跃（tokens=0 → level 0），不得凭空造数据
  const firstCells = heatCells(padded).slice(0, 3).map(c => c.level);
  assert.deepEqual(firstCells, ['0', '0', '0'], '前导补齐格应为 0 档（无活跃）');
});

test('行为：year:true 幂等 —— 已是 53 周的窗口不再补齐', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const full = fixedWindow53w(0);   // 371 天
  const out = H.renderGrid(full, { months: true, year: true });
  assert.equal(heatCells(out).length, 371, '53 周输入应原样 371 格');
  assert.equal(monthSpans(out).length, 12);
});

test('行为：不传 year 时保持后端原始窗口（使用统计页不被补齐）', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const half = fixedWindow('2026-03-29', 26, 0);
  const out = H.renderGrid(half, { months: true });   // 使用统计页口径：无 year
  assert.equal(heatCells(out).length, 182, '无 year 不得补齐，保持 26 周');
  assert.equal(monthSpans(out).length, 6, '26 周原始窗口月份轴为 6 个（前导残月不出标签）');
});

test('接线：欢迎页传 legend:false / months:true / year:true，不再传 fixed', () => {
  const h = makeWelcomeHarness();
  h.context.window.refreshWelcomeActivity();
  h.ajaxes[h.ajaxes.length - 1].done({ code: 200, data: { heatmap: busyWin7() } });
  const opts = h.renderOpts[h.renderOpts.length - 1];
  assert.equal(opts.legend, false, '欢迎页应关闭图例');
  assert.equal(opts.months, true, '欢迎页应开启月份时间轴');
  assert.equal(opts.fixed, undefined, '欢迎页不再传 fixed（改为随输入框同宽拉伸）');
  assert.equal(opts.year, true, '欢迎页应开启窗口补齐到一年（旧 jar 兼容）');
});

test('形态：CSS 具备月份轴与紧凑拉伸规则', () => {
  assert.ok(usageCss.includes('.usage-heat-months'), '缺少月份轴样式');
  assert.match(usageCss, /\.usage-heat-months span \{[^}]*position: absolute/, '月份标签应绝对定位');
  const compactWrap = usageCss.match(/\.usage-heat-compact \{[^}]*\}/);
  assert.ok(compactWrap, '缺少紧凑 wrap 规则');
  assert.match(compactWrap[0], /width:\s*100%/, '紧凑态应随容器拉伸（与输入框同宽对齐）');
  assert.ok(!compactWrap[0].includes('fit-content'), '紧凑态不得再按内容宽收缩');
  assert.ok(!usageCss.includes('--heat-cell'), '固定格宽变量应已移除');
});



/* ══════════════════════════════════════════════════════════════════════
 * 悬停浮层（用户点名：原生 title 太丑 → 自定义展示 时间 / 任务数 / 总 Tokens）
 * ══════════════════════════════════════════════════════════════════════ */

/* 浮层是 DOM 行为，需要最小 document/window 替身。仓库不引 jsdom（既有测试风格），
 * 故手写只够用的桩：createElement 造带 classList/attribute 的轻对象。
 * 【踩坑记忆】这里绝不能让桩「假装成功」：所有断言都必须能因实现缺失而真失败，
 * 桩只提供容器，不替实现做任何逻辑。 */
function makeFakeDom() {
  const made = [];
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      _attrs: {},
      _cls: {},
      innerHTML: '',
      style: { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } },
      offsetWidth: 150,
      offsetHeight: 62,
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
      contains(n) { return n === this || this.children.includes(n); },
      getBoundingClientRect() { return { top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 }; }
    };
    node.classList = {
      add(c) { node._cls[c] = true; },
      remove(c) { delete node._cls[c]; },
      contains(c) { return !!node._cls[c]; }
    };
    made.push(node);
    return node;
  }
  const body = el('body');
  const document = {
    body,
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    getElementById(id) { return made.find(n => n.id === id) || null; },
    createElement: el
  };
  return { document, body, made, el };
}

/* 带 DOM 的完整沙箱：可注入矩形与视口，用于验证翻转/夹紧 */
function loadHeatmapWithDom(opts) {
  opts = opts || {};
  const dom = makeFakeDom();
  const translations = opts.translations || {};
  const gourdI18n = {
    t(key, args) {
      if (Object.prototype.hasOwnProperty.call(translations, key)) {
        let s = translations[key];
        (args || []).forEach((v, i) => { s = s.replace('{' + i + '}', String(v)); });
        return s;
      }
      return key;
    },
    getLocale() { return opts.locale || null; }
  };
  const listeners = {};
  const root = {
    dataset: {},
    _listeners: listeners,
    addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    contains(n) { return !!(n && n._inRoot); }
  };
  const win = {
    GourdI18n: gourdI18n,
    innerWidth: opts.innerWidth || 1200,
    innerHeight: opts.innerHeight || 800,
    addEventListener() {}
  };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    GourdI18n: gourdI18n,
    document: dom.document,
    window: win
  };
  vm.createContext(context);
  vm.runInContext(heatmapJs, context, { filename: 'app-heatmap.js' });
  return { api: context.window.GourdHeatmap, dom, win, root, listeners };
}

/* 造一个能命中 closest 的格子桩 */
function makeCell(rect) {
  const cell = {
    _inRoot: true,
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    getBoundingClientRect() { return rect; },
    closest(sel) { return sel === '.usage-heat-cell[data-date]' && this._attrs['data-date'] ? this : null; }
  };
  return cell;
}

test('浮层：hover 弹出并在正文里给出 时间/任务数/Tokens 三要素', () => {
  const env = loadHeatmapWithDom({
    locale: 'en-US',
    translations: { 'settings.usage.tip_tasks': 'Tasks', 'settings.usage.tip_tokens': 'Tokens used' }
  });
  env.api.mountTip(env.root);
  assert.equal(env.root.dataset.heatTip, '1', '挂载后应打幂等标记');

  const cell = makeCell({ top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '12345');
  cell.setAttribute('data-tasks', '3');
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));

  const tip = env.dom.document.getElementById('usageHeatTip');
  assert.ok(tip, '悬停后应创建浮层节点');
  assert.ok(tip.classList.contains('is-visible'), '浮层应可见');
  assert.ok(tip.innerHTML.includes('usage-heat-tip-date'), '应含日期行');
  assert.ok(tip.innerHTML.includes('Sep 22, 2026'), '日期应按 locale 排版，实际: ' + tip.innerHTML);
  assert.ok(tip.innerHTML.includes('Tasks') && tip.innerHTML.includes('>3<'), '应含任务数 3');
  assert.ok(tip.innerHTML.includes('Tokens used') && tip.innerHTML.includes('12.3K'), '应含紧凑化 token');
  // 原生 title 必须彻底废弃
  assert.ok(!tip.innerHTML.includes('title='), '浮层不得回退到原生 title');
});

test('浮层：单例复用 —— 划过多个格子只存在一个浮层节点', () => {
  const env = loadHeatmapWithDom({ locale: 'en-US', translations: {} });
  env.api.mountTip(env.root);
  for (let i = 0; i < 5; i++) {
    const cell = makeCell({ top: 300, bottom: 312, left: 400 + i * 14, right: 412 + i * 14, width: 12, height: 12 });
    cell.setAttribute('data-date', '2026-09-2' + i);
    cell.setAttribute('data-tokens', String(i * 100));
    cell.setAttribute('data-tasks', '1');
    env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  }
  const tips = env.dom.made.filter(n => n.id === 'usageHeatTip');
  assert.equal(tips.length, 1, '浮层必须单例，实际创建了 ' + tips.length + ' 个');
});

test('浮层：mouseleave 收起；同一格重复 mouseover 不重复排版', () => {
  const env = loadHeatmapWithDom({ locale: 'en-US', translations: {} });
  env.api.mountTip(env.root);
  const cell = makeCell({ top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '100');
  cell.setAttribute('data-tasks', '2');
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  const tip = env.dom.document.getElementById('usageHeatTip');
  assert.ok(tip.classList.contains('is-visible'));
  const htmlAfterFirst = tip.innerHTML;
  // 子元素冒泡导致的重复 mouseover：内容与节点都不应变
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  assert.equal(tip.innerHTML, htmlAfterFirst, '重复悬停同一格不应重建内容');
  env.listeners.mouseleave.forEach(cb => cb({}));
  assert.ok(!tip.classList.contains('is-visible'), 'mouseleave 应收起浮层');
});

/* 【实测缺陷回归】鼠标从格子移到同一 root 内的非格子区域（月份轴 / 图例 / 格间缝隙）时，
 * mouseleave 不会触发（它只管“离开整个 root”），旧实现于是让浮层挂着一个
 * 已经不再悬停的格子的数据一直亮着。浏览器实测已复现（D1 = FAIL）。 */
test('浮层：鼠标移到同 root 内的非格子区域（图例/月份轴）应收起', () => {
  const env = loadHeatmapWithDom({ locale: 'en-US', translations: {} });
  env.api.mountTip(env.root);
  const cell = makeCell({ top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '100');
  cell.setAttribute('data-tasks', '2');
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  const tip = env.dom.document.getElementById('usageHeatTip');
  assert.ok(tip.classList.contains('is-visible'));

  // 非格子元素：closest 恒 null，且在 root 内
  const legend = { _inRoot: true, closest() { return null; } };
  env.listeners.mouseover.forEach(cb => cb({ target: legend }));
  assert.ok(!tip.classList.contains('is-visible'), '移到图例后浮层必须收起（否则显示的是上一个格子的数据）');
});

/* 【实测缺陷回归】视图隐藏走的是 display:none，指针下的元素直接消失，mouseleave 永不触发，
 * 浮层会带着旧内容停在屏幕上（切到聊天/技能页后它依旧悬在那里）。
 * 生产代码用 IntersectionObserver 兜底（对 display:none 会回调 isIntersecting=false，已实测）；
 * 这里注入一个可控的 IO 桩，验证“不可见 → hideTip”这条接线确实存在。 */
test('浮层：根节点变为不可见（切页）时必须收起（IO 兜底接线）', () => {
  const observations = [];
  // 注：不需要先跑一个无 IO 的沙箱；下面直接建带 IO 桩的那一份。
  const dom2 = makeFakeDom();
  const i18n2 = { t: k => k, getLocale: () => 'en-US' };
  const listeners2 = {};
  const root2 = {
    dataset: {}, addEventListener(ev, cb) { (listeners2[ev] = listeners2[ev] || []).push(cb); },
    contains: n => !!(n && n._inRoot)
  };
  function FakeIO(cb) { this._cb = cb; }
  FakeIO.prototype.observe = function (el) { observations.push({ el, cb: this._cb }); };
  FakeIO.prototype.disconnect = function () {};
  const ctx2 = {
    console: { log() {}, warn() {}, error() {} },
    GourdI18n: i18n2,
    IntersectionObserver: FakeIO,
    document: dom2.document,
    window: { GourdI18n: i18n2, innerWidth: 1200, innerHeight: 800, addEventListener() {} }
  };
  vm.createContext(ctx2);
  vm.runInContext(heatmapJs, ctx2, { filename: 'app-heatmap.js' });
  ctx2.window.GourdHeatmap.mountTip(root2);

  assert.equal(observations.length, 1, 'mountTip 应观察根节点（只 1 个，不是 371 个格子）');
  assert.equal(observations[0].el, root2, '应观察传入的根节点');

  const cell = makeCell({ top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '5');
  cell.setAttribute('data-tasks', '1');
  listeners2.mouseover.forEach(cb => cb({ target: cell }));
  const tip = dom2.document.getElementById('usageHeatTip');
  assert.ok(tip.classList.contains('is-visible'), '前置：悬停后浮层应可见');

  observations[0].cb([{ isIntersecting: false, intersectionRatio: 0 }]);
  assert.ok(!tip.classList.contains('is-visible'), '根节点不可见时必须收起浮层（否则切页后残影）');
  // 反向：回可见时不得自己弹出来（只能由真正悬停触发）
  observations[0].cb([{ isIntersecting: true, intersectionRatio: 1 }]);
  assert.ok(!tip.classList.contains('is-visible'), '重新可见不应自行弹出');
});

/* 【实测缺陷回归】切语言后：
 *  - 已渲染格子的 aria-label 还是旧语言（读屏器读的是属性，不看浮层）；
 *  - 正在悬停的浮层文本也是旧语言（要移开再移回才更新）。
 * 统计页本来根本没监听 i18n:localeChanged，本轮一并补上。 */
test('浮层：切语言后 refreshLabels 就地刷新 aria-label；refreshVisibleTip 刷新正在显示的浮层', () => {
  const translations = { 'settings.usage.tip_tasks': 'Tasks', 'settings.usage.tip_tokens': 'Tokens used' };
  const env = (() => {
    // 沿用 loadHeatmapWithDom 的构建方式，但 translations 需要在闭包外可改
    const dom = makeFakeDom();
    const i18n = {
      t(key) { return Object.prototype.hasOwnProperty.call(translations, key) ? translations[key] : key; },
      getLocale() { return 'en-US'; }
    };
    const listeners = {};
    const root = {
      dataset: {}, addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
      contains: n => !!(n && n._inRoot),
      // refreshLabels 要用 querySelectorAll：返回一个可控的格子列表
      _cells: [],
      querySelectorAll() { return this._cells; }
    };
    const ctx = {
      console: { log() {}, warn() {}, error() {} },
      GourdI18n: i18n,
      document: dom.document,
      window: { GourdI18n: i18n, innerWidth: 1200, innerHeight: 800, addEventListener() {} }
    };
    vm.createContext(ctx);
    vm.runInContext(heatmapJs, ctx, { filename: 'app-heatmap.js' });
    return { api: ctx.window.GourdHeatmap, dom, root, listeners };
  })();

  const cell = makeCell({ top: 300, bottom: 312, left: 400, right: 412, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '100');
  cell.setAttribute('data-tasks', '2');
  // makeCell 的 setAttribute 只写 _attrs。
  // 【为何用哨兵值而不是真中文】
  // 第一版把初始 aria-label 设成真中文「任务数 2」，再切到中文后断言 includes('任务数') ——
  // 变异 M4（删掉 setAttribute 回写）居然存活：因为旧值本身就包含「任务数」，
  // 断言验的是“包含”而不是“被更新过”。类型陷阱：**要证明“发生了变更”，初始值必须不满足终态断言**。
  // 改用不含任何译文词的哨兵串，这样不回写就一定会红。
  const STALE = '__STALE_OLD_LANG__';
  cell.setAttribute('aria-label', STALE);
  assert.equal(cell.getAttribute('aria-label'), STALE, '前置：标签初始为哨兵值');

  env.root._cells = [cell];
  env.api.mountTip(env.root);
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  const tip = env.dom.document.getElementById('usageHeatTip');
  assert.ok(tip.innerHTML.includes('Tasks'), '前置：浮层初始为英文（当前 locale=en-US）');

  // 切到中文：只改翻译表，不动 DOM
  translations['settings.usage.tip_tasks'] = '任务数';
  translations['settings.usage.tip_tokens'] = '消耗 Tokens';

  const n = env.api.refreshLabels(env.root);
  assert.equal(n, 1, 'refreshLabels 应作用于所有已渲染格子');
  const afterLabel = cell.getAttribute('aria-label');
  assert.notEqual(afterLabel, STALE, '切语言后 aria-label 必须被重写（哨兵值不得残留）');
  assert.ok(afterLabel.includes('任务数'),
    '切语言后 aria-label 必须是新语言，实际: ' + afterLabel);
  assert.ok(!afterLabel.includes('Tasks'), '不得残留旧语言，实际: ' + afterLabel);

  env.api.refreshVisibleTip();
  assert.ok(tip.innerHTML.includes('任务数'),
    '正在悬停的浮层必须立即跟随新语言（不能要用户移开再移回），实际: ' + tip.innerHTML);
  assert.ok(!tip.innerHTML.includes('Tasks'), '不得残留旧语言');
  // 刷新后仍必须可见（refreshVisibleTip 不能把浮层弄成消失态）
  assert.ok(tip.classList.contains('is-visible'), '刷新文案不应收起浮层');
});

/* 接线：统计页在切语言时必须真的调 refreshLabels / refreshVisibleTip，
 * 且 closeUsage 必须收起浮层（否则视图隐藏后残影）。
 * 同样剥注释后断言，防止“注释里写了就算数”。 */
test('接线：统计页监听 i18n:localeChanged 并在 closeUsage 收起浮层', () => {
  const code = squish(stripComments(settingsUsageJs));
  assert.ok(code.includes("addEventListener('i18n:localeChanged'"),
    '统计页必须监听语言切换（否则卡片标题/单位/浮层文案全停在旧语言）');
  assert.ok(code.includes('GourdHeatmap.refreshLabels') || code.includes('renderBody(lastData)'),
    '切语言后必须刷新已渲染内容（含格子 aria-label）');
  const closeFn = stripComments(settingsUsageJs);
  const i = closeFn.indexOf('function closeUsage()');
  assert.ok(i >= 0, 'closeUsage 应存在');
  const body = closeFn.slice(i, closeFn.indexOf('}', i));
  assert.ok(/GourdHeatmap\.hideTip/.test(body),
    'closeUsage 必须收起浮层：视图 display:none 后 mouseleave 永不触发，浮层会残留在别的页面上');
});

test('浮层：默认在上方，顶部空间不足自动翻到下方；水平方向夹紧在视口内', () => {
  const env = loadHeatmapWithDom({ locale: 'en-US', translations: {}, innerWidth: 1200, innerHeight: 800 });
  env.api.mountTip(env.root);

  // ① 空间充足 → 上方
  const mid = makeCell({ top: 400, bottom: 412, left: 600, right: 612, width: 12, height: 12 });
  mid.setAttribute('data-date', '2026-09-22');
  mid.setAttribute('data-tokens', '1');
  env.listeners.mouseover.forEach(cb => cb({ target: mid }));
  let tip = env.dom.document.getElementById('usageHeatTip');
  assert.equal(tip.getAttribute('data-placement'), 'top', '默认应在上方');
  assert.ok(parseInt(tip.style.top, 10) < 400, '上方时 top 应小于格子 top');

  // ② 贴着视口顶部（欢迎页热力图就是这种位置）→ 翻到下方
  const topCell = makeCell({ top: 2, bottom: 14, left: 600, right: 612, width: 12, height: 12 });
  topCell.setAttribute('data-date', '2026-09-23');
  topCell.setAttribute('data-tokens', '2');
  env.listeners.mouseover.forEach(cb => cb({ target: topCell }));
  assert.equal(tip.getAttribute('data-placement'), 'bottom', '顶部放不下时应翻到下方');
  assert.ok(parseInt(tip.style.top, 10) >= 14, '下方时 top 应在格子下方');

  // ③ 最左列 / 最右列 → 左右夹紧，不得越出视口
  const leftCell = makeCell({ top: 400, bottom: 412, left: 0, right: 10, width: 10, height: 12 });
  leftCell.setAttribute('data-date', '2026-09-24');
  leftCell.setAttribute('data-tokens', '3');
  env.listeners.mouseover.forEach(cb => cb({ target: leftCell }));
  assert.ok(parseInt(tip.style.left, 10) >= 8, '左侧应夹到 8px 边距，实际 ' + tip.style.left);

  const rightCell = makeCell({ top: 400, bottom: 412, left: 1190, right: 1200, width: 10, height: 12 });
  rightCell.setAttribute('data-date', '2026-09-25');
  rightCell.setAttribute('data-tokens', '4');
  env.listeners.mouseover.forEach(cb => cb({ target: rightCell }));
  const leftPx = parseInt(tip.style.left, 10);
  assert.ok(leftPx + tip.offsetWidth <= 1200 - 8 + 1, '右侧应夹进视口，left=' + leftPx + ' w=' + tip.offsetWidth);
});

test('浮层：后端未返回 sessions（旧 jar）时整行省略，不伪造「0 个任务」', () => {
  const env = loadHeatmapWithDom({
    locale: 'zh-CN',
    translations: { 'settings.usage.tip_tasks': '任务数', 'settings.usage.tip_tokens': '消耗 Tokens' }
  });
  env.api.mountTip(env.root);
  const cell = makeCell({ top: 400, bottom: 412, left: 600, right: 612, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '500');
  // data-tasks 为空串 = 后端未提供
  cell.setAttribute('data-tasks', '');
  env.listeners.mouseover.forEach(cb => cb({ target: cell }));
  const tip = env.dom.document.getElementById('usageHeatTip');
  assert.ok(!tip.innerHTML.includes('任务数'), '未知任务数不得渲染该行，实际: ' + tip.innerHTML);
  assert.ok(tip.innerHTML.includes('消耗 Tokens'), 'Token 行必须仍在');
  // 明确传 0 时仍要展示（「那天 0 个任务」是真实信息，与「不知道」不同）
  const cell0 = makeCell({ top: 400, bottom: 412, left: 600, right: 612, width: 12, height: 12 });
  cell0.setAttribute('data-date', '2026-09-22');
  cell0.setAttribute('data-tokens', '0');
  cell0.setAttribute('data-tasks', '0');
  env.listeners.mouseover.forEach(cb => cb({ target: cell0 }));
  assert.ok(tip.innerHTML.includes('任务数'), '明确为 0 时应展示该行');
});

test('浮层：mountTip 幂等（重复挂载不叠加监听）', () => {
  const env = loadHeatmapWithDom({ locale: 'en-US', translations: {} });
  env.api.mountTip(env.root);
  const n1 = (env.listeners.mouseover || []).length;
  env.api.mountTip(env.root);
  const n2 = (env.listeners.mouseover || []).length;
  assert.equal(n1, n2, '重复挂载不得重复绑定监听');
  assert.ok(n1 > 0, '首次挂载必须真的绑上监听');
});

test('浮层：CSS 具备可见态/定位/指向三角/低层级约束', () => {
  assert.ok(usageCss.includes('.usage-heat-tip'), '缺少浮层样式');
  const base = usageCss.match(/\.usage-heat-tip \{[^}]*\}/);
  assert.ok(base, '缺少浮层基础规则');
  assert.match(base[0], /position:\s*fixed/, '浮层必须 fixed（脱离卡片 overflow 裁剪）');
  assert.match(base[0], /pointer-events:\s*none/, '必须 pointer-events:none，否则悬停会自我闪烁');
  assert.match(base[0], /z-index:\s*\d+/, '必须显式指定层级');
  const z = Number(base[0].match(/z-index:\s*(\d+)/)[1]);
  assert.ok(z < 10000, '浮层不得高于设置弹层(10000)，实际 ' + z);
  assert.ok(z > 990, '浮层应高于普通内容层，实际 ' + z);
  // 显示由 .is-visible 切换：默认 display:none 才能避免空盒子占位
  assert.match(base[0], /display:\s*none/, '默认应隐藏');
  assert.ok(/\.usage-heat-tip\.is-visible\s*\{[^}]*display:\s*block/.test(usageCss), '缺少 is-visible 显示规则');
  // 上下两种朝向的三角都要有
  assert.ok(usageCss.includes('[data-placement="top"]::after'), '缺少指向上方三角');
  assert.ok(usageCss.includes('[data-placement="bottom"]::after'), '缺少指向下方三角');
});

/* 【实测缺陷回归】nowrap + 固定 max-width 的组合不限制内容宽度：
 * 实测法语/俄语长译文下浮层 scrollWidth=300 > clientWidth=260，文字直接画到盒外
 * 叠在页面其他内容上；240px 视口下 260px 的盒子整个越出屏幕（右边界 268px）。
 * 这里锁住修法：不得用裸 nowrap，且 max-width 必须受视口约束。 */
test('浮层：CSS 不得用裸 nowrap + 固定 max-width（长译文会溢出盒子）', () => {
  // 必须先剥注释：本会话第三次因为“断言命中注释”而假绿（M8 存活）
  const css = stripCssComments(usageCss);
  const base = css.match(/\.usage-heat-tip \{[^}]*\}/)[0];
  // 全局 nowrap 是溢出元凶：它让盒子最小宽度由最长一行决定
  assert.ok(!/white-space:\s*nowrap/.test(base),
    '浮层基础规则不得全局 nowrap（长译文会把内容顶到盒外）');
  // max-width 必须能随视口收缩（不能只写 260px）
  const maxW = (base.match(/max-width:\s*([^;]+);/) || [])[1] || '';
  assert.ok(maxW.trim().length > 0, '缺少 max-width');
  assert.ok(/100vw/.test(maxW) || /min\(/.test(maxW),
    'max-width 必须受视口约束（否则窄窗口浮层越出屏幕），实际: ' + maxW);
  // 标签列：flex 子项必须能收缩（min-width:0），否则长译文仍会把行撑宽
  const k = css.match(/\.usage-heat-tip-k \{[^}]*\}/);
  assert.ok(k, '缺少标签列规则');
  assert.match(k[0], /min-width:\s*0/, '标签列必须 min-width:0（flex 子项默认 min-width:auto，不会收缩）');
  // 数值列反向：不能被折行拆开（「1,2」/「Mio.」分两行就读不懂了）
  const v = css.match(/\.usage-heat-tip-v \{[^}]*\}/);
  assert.ok(v, '缺少数值列规则');
  assert.match(v[0], /white-space:\s*nowrap/, '数值不得折行');
});

/* ══════════════════════════════════════════════════════════════════════
 * 国际化：用户点名「tips 里的内容没做国际化」
 * ══════════════════════════════════════════════════════════════════════ */
const localeDir = path.join(staticRoot, 'locales');
const localeFiles = fs.readdirSync(localeDir).filter(f => f.endsWith('.json'));
const tipsKeys = ['tip_tasks', 'tip_tokens'];
/* 这些键的译文允许与英文一致（国际化里正常同形：语言本身就这么写，或是纯符号/缩写） */
const SAME_AS_EN_OK = new Set(['tokens_unit', 'date_ym', 'stat_sessions', 'stat_messages', 'stat_tokens']);

function usageOf(code) {
  const raw = fs.readFileSync(path.join(localeDir, code + '.json'), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw).settings.usage;
}

test('i18n：12 个语言包都具备浮层文案键，且非英文占位', () => {
  assert.equal(localeFiles.length, 12, '语言包数量应为 12，实际 ' + localeFiles.length);
  const en = usageOf('en');
  for (const f of localeFiles) {
    const code = f.replace('.json', '');
    const u = usageOf(code);
    for (const k of tipsKeys) {
      assert.equal(typeof u[k], 'string', code + ' 缺少 settings.usage.' + k);
      assert.ok(u[k].trim().length > 0, code + ' 的 ' + k + ' 不得为空');
      if (code !== 'en') {
        assert.notEqual(u[k], en[k], code + ' 的 ' + k + ' 仍是英文占位：' + u[k]);
      }
    }
  }
});

test('i18n：除英文外不得有整块照抄英文（历史缺陷：9 个语言包 usage 全是英文）', () => {
  const en = usageOf('en');
  const keys = Object.keys(en);
  for (const f of localeFiles) {
    const code = f.replace('.json', '');
    if (code === 'en') continue;
    const u = usageOf(code);
    const same = keys.filter(k => !SAME_AS_EN_OK.has(k) && u[k] === en[k]);
    assert.equal(same.length, 0, code + ' 仍有 ' + same.length + ' 个键照抄英文：' + same.join(', '));
  }
});

test('i18n：所有语言包的 usage 键集合与顺序完全一致（缺键会回退成原始 key 显示）', () => {
  const enKeys = Object.keys(usageOf('en'));
  for (const f of localeFiles) {
    const code = f.replace('.json', '');
    assert.deepEqual(Object.keys(usageOf(code)), enKeys, code + ' 的 usage 键集合/顺序与 en 不一致');
  }
});

test('i18n：占位符集合与 en 一致（date_ym 双占位是已知例外）', () => {
  const en = usageOf('en');
  // 不用正则：这段断言曾两次因反斜杠在写入时丢失而变成恒真（`/{d+}/` 什么都匹配不到，
  // 所有语言包一律得到空字符串 → 变异 M15「占位符被吞」存活）。改为纯字符扫描，零转义风险。
  const ph = s => {
    const out = [];
    const t = String(s);
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '{') continue;
      const close = t.indexOf('}', i + 1);
      if (close < 0) break;
      const inner = t.slice(i + 1, close);
      if (inner.length > 0 && inner.split('').every(c => c >= '0' && c <= '9')) out.push(t.slice(i, close + 1));
      i = close;
    }
    return out.sort().join(',');
  };
  // date_ym 是【故意】的双占位契约：调用方传 [年, 补零月, 不补零月]，
  // 英文系模板取 {1} 得 2026-08，中文/日文取 {2} 得 2026年8月。
  // 它天然不可能与 en 同形，否则「2026年08月」这种补零写法会露到中文界面上。
  const DUAL_SLOT = new Set(['date_ym']);
  for (const f of localeFiles) {
    const code = f.replace('.json', '');
    const u = usageOf(code);
    for (const k of Object.keys(en)) {
      if (DUAL_SLOT.has(k)) continue;
      assert.equal(ph(u[k]), ph(en[k]), code + ' 的 ' + k + ' 占位符与 en 不一致');
    }
    // date_ym 单独校验：必须含 {0}（年）与恰好一个月份占位（{1} 补零 / {2} 不补零）
    const dy = ph(u.date_ym);
    assert.ok(dy.indexOf('{0}') >= 0, code + ' 的 date_ym 必须含 {0}（年），实际 ' + dy);
    const monthSlots = dy.split(',').filter(x => x === '{1}' || x === '{2}');
    assert.equal(monthSlots.length, 1, code + ' 的 date_ym 必须恰好一个月份占位，实际 ' + dy);
  }
});

test('i18n：不得在代码里硬编码中文数字单位（万/亿）与中文日期模板', () => {
  // 用户点名的「没做国际化」之一：单位写死在 JS 里，语言包再全也救不回来
  assert.ok(!/['"]亿['"]/.test(heatmapJs), '热力图组件不得硬编码「亿」');
  assert.ok(!/\+\s*'万'/.test(heatmapJs), '热力图组件不得硬编码「万」');
  assert.ok(!/settings.usage.date_md/.test(heatmapJs), '热力图不再使用中文日期模板，应交给 Intl');
  assert.ok(!/settings.usage.tooltip/.test(heatmapJs), '旧 tooltip 模板已废弃（浮层用 tip_tasks/tip_tokens）');
  // 使用统计页同口径
  assert.ok(!/['"]亿['"]/.test(settingsUsageJs), '统计页不得硬编码「亿」');
  assert.ok(!/\+\s*'万'/.test(settingsUsageJs), '统计页不得硬编码「万」');
  assert.ok(/Intl.NumberFormat/.test(settingsUsageJs), '统计页数值格式化应走 Intl');
  /* 【本断言曾经是假绿】原写法 /notation:s*'compact'/ 的两个问题：
   *  1) 反斜杠在写入时丢失，变成 `notation:` 后跟任意个 s —— 真正想查的 \s* 没查；
   *  2) 更致命：它扫的是【带注释的原文】，而文件注释里就写着
   *     「改用 Intl.NumberFormat(notation:'compact')」—— 把真实代码里的
   *     { notation: 'compact' } 删掉后断言依旧 PASS（已用变异实测确认）。
   * 修法：先剥注释，再去空白，然后查“调用形态”而不是“词出现过”。
   * 去空白后真实调用形式为 notation:'compact'（引号可能单可能双）。 */
  const usageCode = squish(stripComments(settingsUsageJs));
  assert.ok(/notation:['"]compact['"]/.test(usageCode),
    '统计页应在【实际代码】里使用 compact 记法（注释里的描述不算）');
});

test('i18n：切语言后浮层文案跟随（同一格子重新悬停即更新）', () => {
  // 模拟真实切换：GourdI18n.t 返回的表被替换后，浮层重建内容必须用新表
  const translations = { 'settings.usage.tip_tasks': 'Tasks', 'settings.usage.tip_tokens': 'Tokens used' };
  const dom = makeFakeDom();
  const i18n = {
    t(key, args) {
      if (Object.prototype.hasOwnProperty.call(translations, key)) return translations[key];
      return key;
    },
    getLocale() { return 'en-US'; }
  };
  const listeners = {};
  const root = { dataset: {}, addEventListener(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); }, contains: () => true };
  const context = {
    console: { log() {}, warn() {}, error() {} },
    GourdI18n: i18n,
    document: dom.document,
    window: { GourdI18n: i18n, innerWidth: 1200, innerHeight: 800, addEventListener() {} }
  };
  vm.createContext(context);
  vm.runInContext(heatmapJs, context, { filename: 'app-heatmap.js' });
  context.window.GourdHeatmap.mountTip(root);

  const cell = makeCell({ top: 400, bottom: 412, left: 600, right: 612, width: 12, height: 12 });
  cell.setAttribute('data-date', '2026-09-22');
  cell.setAttribute('data-tokens', '100');
  cell.setAttribute('data-tasks', '1');
  listeners.mouseover.forEach(cb => cb({ target: cell }));
  const tip = dom.document.getElementById('usageHeatTip');
  assert.ok(tip.innerHTML.includes('Tasks'), '初次应为英文');

  translations['settings.usage.tip_tasks'] = '任务数';
  translations['settings.usage.tip_tokens'] = '消耗 Tokens';
  listeners.mouseleave.forEach(cb => cb({}));
  listeners.mouseover.forEach(cb => cb({ target: cell }));
  assert.ok(tip.innerHTML.includes('任务数'), '切语言后重新悬停应显示新文案，实际: ' + tip.innerHTML);
  assert.ok(!tip.innerHTML.includes('Tasks'), '不得残留旧语言文案');
});

/* 剥掉 JS 注释，只留可执行代码。
 * 【为什么必须做】接线类断言用 includes('mountTip') 查的是字符串：
 * 我自己的注释里就写着「必须接线 mountTip」，于是把真正的调用删掉后
 * 断言仍然全绿 —— 典型「存在型断言测空气」。变异 M1/M2 就是这样暴露的。
 * 状态机必须同时处理行注释、块注释、字符串与模板串，
 * 否则字符串里的 // 会把后半文件全吃掉。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
      i++; continue;
    }
    // state === 'str'
    if (c === '\\') { out += c + (c2 || ''); i += 2; continue; }
    if (c === quote) { state = 'code'; }
    out += c; i++;
  }
  return out;
}

/* js 去掉所有空白：用于「真的调用了这个函数」这类断言（不受换行/缩进影响） */
const squish = s => s.replace(/\s+/g, '');

test('接线：两个使用方都真的调用了 mountTip（剥注释后断言）', () => {
  const welcomeCode = squish(stripComments(welcomeJs));
  const usageCode = squish(stripComments(settingsUsageJs));
  assert.ok(welcomeCode.includes('GourdHeatmap.mountTip(body)'),
    '欢迎页必须真的调用 mountTip(body)（删掉就白渲染了）');
  assert.ok(welcomeCode.indexOf('GourdHeatmap.renderGrid') < welcomeCode.indexOf('GourdHeatmap.mountTip'),
    '应在 renderGrid 之后挂载（节点必须先存在）');
  assert.ok(usageCode.includes('GourdHeatmap.mountTip('),
    '使用统计页必须真的调用 mountTip');
  // 反向保护：剥注释后不存在裸字符串检查（防止有人把真实调用改回注释里的描述）
  assert.ok(!/if\(typeofwindow\.GourdHeatmap\.mountTip===\'function\'\)\s*$/.test(welcomeCode),
    '不能只有类型判断而没有调用');
});
