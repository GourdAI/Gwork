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
  assert.equal((compact.match(/class="usage-heat-cell" data-level=/g) || []).length, 14);
});

test('行为：renderGrid 输出合法网格 —— 列数=周数、格子数=天数、图例 5 档', () => {
  const H = loadHeatmap();
  const heatmap = makeWindow(182, (i) => ({
    date: isoDate(i - 181), tokens: i * 10, rounds: i, future: false
  }));
  const html = H.renderGrid(heatmap);
  assert.match(html, /class="usage-heat-grid" style="grid-template-columns:repeat\(26,1fr\)"/);
  // 182 个格子（全部非 future）
  assert.equal((html.match(/class="usage-heat-cell" data-level=/g) || []).length, 182);
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
  const levels = [...html.matchAll(/class="usage-heat-cell" data-level="(\d)"/g)].map(m => m[1]);
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
});

test('行为：悬停提示按模板填充日期/数值/轮次，并做 HTML 转义', () => {
  const H = loadHeatmap({
    translations: {
      'settings.usage.tooltip': '{0}：{1} Tokens · {2} 轮',
      'settings.usage.date_md': '{0}月{1}日'
    }
  });
  const heatmap = [{ date: '2026-09-22', tokens: 12345, rounds: 7, future: false }];
  const html = H.renderGrid(heatmap);
  assert.ok(html.includes('title="9月22日：1.2万 Tokens · 7 轮"'), '提示文案应按模板生成，实际: ' + (html.match(/title="[^"]*"/) || [''])[0]);
});

test('行为：tokens 为 0 时保持 0 档（不因 maxTok>0 被抬到 1 档）', () => {
  const H = loadHeatmap();
  const heatmap = [
    { date: '2026-03-01', tokens: 0, rounds: 0, future: false },
    { date: '2026-03-02', tokens: 999, rounds: 3, future: false }
  ];
  const html = H.renderGrid(heatmap);
  const levels = [...html.matchAll(/class="usage-heat-cell" data-level="(\d)"/g)].map(m => m[1]);
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

test('行为：renderGrid 转义悬停提示（引号/尖括号不得截断 title 属性）', () => {
  const H = loadHeatmap({
    translations: {
      'settings.usage.tooltip': '{0}：<b x="1"> & {2}',
      'settings.usage.date_md': '{0}月{1}日'
    }
  });
  const html = H.renderGrid([{ date: '2026-09-22', tokens: 5, rounds: 2, future: false }]);
  const m = html.match(/title="([^"]*)"/);
  assert.ok(m, '应存在 title 属性');
  assert.ok(m[1].includes('&lt;b x=&quot;1&quot;'), '尖括号与引号必须转义，实际: ' + m[1]);
  assert.ok(m[1].includes('&amp;'), '& 必须转义');
  assert.ok(!m[1].includes('<b'), '不得残留裸尖括号');
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
  assert.equal((padded.match(/class="usage-heat-cell" data-level=/g) || []).length, 371, '26 周应被补齐到 53 周(371 格)');
  assert.match(padded, /repeat\(53,1fr\)/, '列模板应为 53 列');
  const spans = monthSpans(padded);
  assert.equal(spans.length, 12, '补齐后月份轴应铺满 12 个标签（前导残月不出），实际 ' + spans.length);
  // 补齐的前导格是零活跃（tokens=0 → level 0），不得凭空造数据
  const firstCells = [...padded.matchAll(/class="usage-heat-cell" data-level="(\d)"/g)].slice(0, 3).map(m => m[1]);
  assert.deepEqual(firstCells, ['0', '0', '0'], '前导补齐格应为 0 档（无活跃）');
});

test('行为：year:true 幂等 —— 已是 53 周的窗口不再补齐', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const full = fixedWindow53w(0);   // 371 天
  const out = H.renderGrid(full, { months: true, year: true });
  assert.equal((out.match(/class="usage-heat-cell" data-level=/g) || []).length, 371, '53 周输入应原样 371 格');
  assert.equal(monthSpans(out).length, 12);
});

test('行为：不传 year 时保持后端原始窗口（使用统计页不被补齐）', () => {
  const H = loadHeatmap({ locale: 'en-US' });
  const half = fixedWindow('2026-03-29', 26, 0);
  const out = H.renderGrid(half, { months: true });   // 使用统计页口径：无 year
  assert.equal((out.match(/class="usage-heat-cell" data-level=/g) || []).length, 182, '无 year 不得补齐，保持 26 周');
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
