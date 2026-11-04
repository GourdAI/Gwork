/**
 * 契约测试：官网联系方式模块（#contact）与二维码白底承载。
 *
 * 背景：二维码图自带白底，而整站是深色科技风。若把图直接贴在深色背景上，
 * 会出现两个真实故障：
 *   1) 白块边缘生硬、像渲染事故（视觉）；
 *   2) 更致命——一旦有人为 .qr-card 或 img 加上半透明底色/滤镜，深色会从白底
 *      后面透出来把亮度拉下来，扫码依赖的亮暗差被吃掉，二维码直接扫不出来（功能）。
 * 所以本测试不只锁版式，而是把「二维码必须坐在不透的纯白上」当成硬约束守住。
 *
 * 另锁两条易漂移点：
 *   A. 导航/页脚的联系入口与 main.js 的 sectionIds 必须同步（漏登记则滚到该区块时导航集体失高亮）；
 *   B. index.html 与 models.html 两页入口一致（历史上两页各写一套导致行为漂移）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 本文件位于 <repo>/gourd-ai-agent/src/test/js/，上溯四级才是仓库根
const siteRoot = path.resolve(__dirname, '../../../../gourd-ai-website');
const readSite = (...parts) => fs.readFileSync(path.join(siteRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const indexHtml = readSite('index.html');
const modelsHtml = readSite('models.html');
const css = readSite('css', 'styles.css');
const mainJs = readSite('js', 'main.js');

/* ---------------- 工具：按选择器提取规则体 ---------------- */

/**
 * 取出 `selector { ... }` 的花括号内部。
 * 必须先剥注释：注释里出现的选择器字样会让字符串匹配命中说明文字而非真实规则。
 */
function ruleBody(selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\s,{}])${esc}\\s*\\{`, 'm');
  const m = stripped.match(re);
  assert.ok(m, `styles.css 应存在规则「${selector}」`);
  const start = stripped.indexOf('{', m.index + m[0].length - 1) + 1;
  let depth = 1, i = start;
  while (i < stripped.length && depth > 0) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `规则「${selector}」花括号未配平`);
  return stripped.slice(start, i - 1);
}

const contactSection = (() => {
  const at = indexHtml.indexOf('id="contact"');
  assert.ok(at >= 0, 'index.html 必须有 id="contact"');
  const start = indexHtml.lastIndexOf('<section', at);
  const end = indexHtml.indexOf('</section>', at);
  return indexHtml.slice(start, end);
})();

/* ---------------- 位置与存在性 ---------------- */

test('联系方式区块存在，且排在下载区之后、footer 之前（用户指定的显眼位）', () => {
  const downloads = indexHtml.indexOf('id="downloads"');
  const contact = indexHtml.indexOf('id="contact"');
  const mainEnd = indexHtml.indexOf('</main>');
  const footer = indexHtml.indexOf('<footer');
  assert.ok(downloads >= 0 && contact >= 0, '下载区与联系区都应存在');
  assert.ok(contact > downloads, '#contact 应位于 #downloads 之后');
  assert.ok(contact < mainEnd, '#contact 应在 <main> 内');
  assert.ok(mainEnd < footer, 'footer 应在 </main> 之后（前提校验）');
});

test('二维码图片资源真实存在，且 <img> 带 alt 与宽高（防坏链与布局跳动）', () => {
  const m = contactSection.match(/<img\b[^>]*>/);
  assert.ok(m, '#contact 内必须有 <img>');
  const tag = m[0];
  const src = (tag.match(/src="([^"]+)"/) || [])[1];
  assert.ok(src, '二维码 <img> 必须有 src');
  assert.doesNotMatch(src, /^https?:/, '二维码应走本地 assets，不外链第三方（外链挂了=联系入口失效）');
  const abs = path.join(siteRoot, src);
  assert.ok(fs.existsSync(abs), `二维码文件不存在：${src}`);
  assert.match(tag, /alt="[^"]*[QQ联市扫][^"]*"/, 'alt 必须是有意义文本（无障碍 + 图片挂了仍说明用途）');
  assert.match(tag, /\bwidth="\d+"[\s\S]*\bheight="\d+"/, '<img> 应写 width/height 以避免加载时布局跳动');
  // 尺寸与实际文件一致（PNG IHDR 的宽高）
  const buf = fs.readFileSync(abs);
  assert.equal(buf.slice(1, 8).toString('hex'), '504e470d0a1a0a', '二维码必须是合法 PNG');
  assert.equal(buf.readUInt32BE(16), Number(tag.match(/width="(\d+)"/)[1]), 'width 属性应与真实像素宽一致');
  assert.equal(buf.readUInt32BE(20), Number(tag.match(/height="(\d+)"/)[1]), 'height 属性应与真实像素高一致');
});

/* ---------------- 白底硬约束（本次核心） ---------------- */

test('.qr-card 背景必须是不透的纯白：任何半透明都会让深色透出、吃掉扫码对比度', () => {
  const body = ruleBody('.qr-card');
  const bg = (body.match(/background(?:-color)?\s*:\s*([^;]+);/) || [])[1];
  assert.ok(bg, '.qr-card 必须显式声明背景');
  const value = bg.trim();
  // 允许：var(--white) / #fff(f) / white / rgb(255,255,255)（不带 alpha）
  const opaqueWhite =
    /^var\(\s*--white\s*\)$/.test(value) ||
    /^#(fff|ffffff)\b/i.test(value) ||
    /^rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)$/.test(value) ||
    value === 'white';
  assert.ok(opaqueWhite, `.qr-card 背景应为不透纯白，实得「${value}」`);
  assert.doesNotMatch(value, /rgba|color-mix|\/\s*\d/, '.qr-card 背景不得含 alpha 通道');
  assert.doesNotMatch(body, /backdrop-filter/, '.qr-card 不应使用毛玻璃（会把深色混进白底）');
  assert.doesNotMatch(body, /opacity\s*:\s*[.0-9]/, '.qr-card 不应整体降透明度');
});

test('二维码 <img> 不得被滤镜/混合模式削弱，且自身也落在白底上（双保险）', () => {
  const body = ruleBody('.qr-card img');
  assert.doesNotMatch(body, /mix-blend-mode|filter\s*:/, 'img 不得用混合模式或滤镜（invert/灰度等会直接破坏扫码）');
  assert.doesNotMatch(body, /opacity\s*:\s*[.0-9]/, 'img 不应半透明');
  assert.match(body, /display\s*:\s*block\s*;/, 'img 应 display:block（否则基线对齐留缝，白卡底部出现深色间隙）');
  const bg = (body.match(/background(?:-color)?\s*:\s*([^;]+);/) || [])[1];
  // 只断言「有背景」是不够的：改成 var(--bg)（深色）同样是背景，却会把二维码扫不起来。
  // 必须像 .qr-card 那样把颜色值夹死在不透纯白的取值域内。
  assert.ok(bg, 'img 也应自带白底：卡片内边距之外的区域仍须是亮色');
  const value = bg.trim();
  const opaqueWhite =
    /^var\(\s*--white\s*\)$/.test(value) ||
    /^#(fff|ffffff)\b/i.test(value) ||
    /^rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)$/.test(value) ||
    value === 'white';
  assert.ok(opaqueWhite, `img 背景应为不透纯白，实得「${value}」`);
  assert.doesNotMatch(value, /rgba|--bg|--text|color-mix/, 'img 背景不得用页面深色令牌或含 alpha');
});

test('--white 令牌确为纯白（上面断言的前提）', () => {
  const root = ruleBody(':root');
  assert.match(root, /--white\s*:\s*#ffffff\s*;/i, '--white 应是 #ffffff');
});

/* ---------------- 静区（quiet zone）与对比度：可扫性硬指标 ---------------- */

const { decodePng, measureQr, quietModulesAfterRender, lumOf } = require('./lib/png-qr-metrics.js');

/** 从 CSS 取指定断点下 .qr-card 的 padding 与 .qr-card img 的显示宽（真实版式参数）。 */
function renderedQrParams(maxWidth) {
  const block = maxWidth === null
    ? css
    : (css.match(new RegExp(`@media \\(max-width: ${maxWidth}px\\) \\{[\\s\\S]*?\\n\\}`)) || [])[0];
  if (!block) return null;
  const pad = block.match(/\.qr-card \{ padding: (\d+)px;/);
  const img = block.match(/\.qr-card img \{ width: (\d+)px;/) || block.match(/\.qr-card img \{[\s\S]*?width: (\d+)px/);
  if (!pad || !img) return null;
  return { displayWidth: Number(img[1]), padding: Number(pad[1]) };
}

test('二维码图自带静区不足 4 模块：白卡内边距必须把它补到 >=4（否则扫码器拒识）', () => {
  const m = measureQr(decodePng(fs.readFileSync(path.join(siteRoot, 'assets', 'qr-contact.png'))));

  // 前提坐实：图本身确实不达标，所以「卡片 padding 兼作静区」不是注释里说说，而是真需求
  assert.ok(m.quietModulesInImage < 4,
    `前提已变：图内静区达 ${m.quietModulesInImage.toFixed(2)} 模块，不再依赖卡片 padding，应重审本用例`);

  // 桌面板式：基础规则的 padding + img 宽
  const base = {
    displayWidth: Number((ruleBody('.qr-card img').match(/width:\s*(\d+)px/) || [])[1]),
    padding: Number((ruleBody('.qr-card').match(/padding:\s*(\d+)px/) || [])[1]),
  };
  assert.ok(base.displayWidth && base.padding, '应能从基础规则读出 img 宽与卡片 padding');
  const desktop = quietModulesAfterRender(m, base.displayWidth, base.padding);
  assert.ok(desktop >= 4, `桌面最终静区仅 ${desktop.toFixed(2)} 模块，低于 QR 规范的 4，将扫不出来`);

  // 窄屏：padding 与显示宽都缩小，仍必须达标（最容易被打穿的一档）
  const mobile = renderedQrParams(767);
  assert.ok(mobile, '767px 断点应同时给出 .qr-card padding 与 img width');
  const mQuiet = quietModulesAfterRender(m, mobile.displayWidth, mobile.padding);
  assert.ok(mQuiet >= 4, `窄屏最终静区仅 ${mQuiet.toFixed(2)} 模块，手机扫码会被拒`);
});

test('二维码对比度达标（明度差 >=120）且全图不透明，白底是真白而非透明', () => {
  const img = decodePng(fs.readFileSync(path.join(siteRoot, 'assets', 'qr-contact.png')));
  let minLum = 255, maxLum = 0, opaque = 0;
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const l = lumOf(img, x, y);
      if (l < minLum) minLum = l;
      if (l > maxLum) maxLum = l;
      if (img.ch === 4 && img.data[y * img.stride + x * img.ch + 3] === 255) opaque++;
    }
  }
  // 原图是浅蓝码点（亮差仅 ~86），手机反光环境下极易扫不出；处理后的基线应在 200+
  assert.ok(maxLum - minLum >= 120, `明度差仅 ${(maxLum - minLum).toFixed(0)}，低于扫码安全线 120`);
  assert.equal(opaque, img.w * img.h, '全图必须完全不透明（透明像素会把页面底色混进白底）');
  assert.ok(minLum < 100, '码点应足够深');
});

/* ---------------- 入口一致性（防漂移） ---------------- */

test('index 顶栏与页脚都有联系入口，且 href 指向 #contact', () => {
  const nav = indexHtml.slice(indexHtml.indexOf('id="navLinks"'), indexHtml.indexOf('</nav>'));
  assert.match(nav, /<a href="#contact">[^<]*联系/, '顶栏应有「联系」项');
  const foot = indexHtml.slice(indexHtml.indexOf('<footer'));
  assert.match(foot, /<a href="#contact">[^<]*联系/, '页脚应有「联系」项');
  assert.ok(indexHtml.match(/href="#contact"/g).length >= 2, '至少两处入口（顶栏 + 页脚）');
});

test('models.html 同步两枚入口，且必须带 index.html#contact 前缀（跨页锚点）', () => {
  const at = modelsHtml.indexOf('index.html#contact');
  assert.ok(at > 0, 'models.html 应存在指向 index 联系区的入口');
  assert.ok(modelsHtml.indexOf('index.html#contact') !== modelsHtml.lastIndexOf('index.html#contact'),
    '顶栏与页脚各一处，共两处');
  assert.doesNotMatch(modelsHtml, /href="#contact"/, 'models.html 自身没有 #contact，不得写本页裸锚点（点了没反应）');
});

test('main.js 的 sectionIds 必须包含 contact（否则滚到该区导航项集体失高亮）', () => {
  const call = mainJs.slice(mainJs.indexOf('GourdSiteNav.setupNav'));
  const ids = call.match(/sectionIds:\s*\[([^\]]*)\]/);
  assert.ok(ids, 'index 调用点应显式传 sectionIds');
  const list = ids[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  for (const id of ['features', 'quickstart', 'downloads', 'contact']) {
    assert.ok(list.includes(id), `sectionIds 应含 ${id}，实得 ${JSON.stringify(list)}`);
  }
  // 顺序即滚动判定顺序：contact 必须排最后（它是最后一个区块）
  assert.equal(list[list.length - 1], 'contact', 'contact 应排在末尾（触底时高亮最后一项）');
  // 声明的 id 必须在页面里真实存在，否则高亮逻辑永远命中不了那一项
  for (const id of list) {
    assert.ok(indexHtml.includes(`id="${id}"`), `sectionIds 里的 ${id} 在 index.html 中不存在`);
  }
});

/* ---------------- 版式健壮性 ---------------- */

test('联系方式版式有响应式降级：窄屏不得把二维码挤出容器', () => {
  const panel = ruleBody('.contact-panel');
  assert.match(panel, /grid-template-columns\s*:/, '宽屏应为双栏 grid');
  assert.match(panel, /minmax\(0,\s*1fr\)/, '文案列必须 minmax(0,1fr)：否则长词撑破栅格导致横向溢出');
  const m1023 = css.match(/@media \(max-width: 1023px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m1023, '应保留 1023px 断点');
  assert.match(m1023[0], /\.contact-panel\s*\{[\s\S]*?grid-template-columns:\s*1fr/, '≤1023px 应转单栏');
  const m767 = css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m767, '应保留 767px 断点');
  assert.match(m767[0], /\.qr-card img\s*\{[\s\S]*?width:\s*\d+px/, '≤767px 应缩小二维码');
});

test('减少动态效果偏好下卡片不动（无障碍纪律，与全站其它区块一致）', () => {
  const rm = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) || [];
  assert.ok(rm.length >= 1, '应存在 reduced-motion 适配块');
  const hit = rm.find(b => /qr-card/.test(b));
  assert.ok(hit, 'reduced-motion 块应覆盖 .qr-card');
  assert.match(hit, /\.qr-card\s*\{[^}]*transition:\s*none/, '.qr-card 过渡应关闭');
});

test('联系方式文案不承诺未核实的渠道（只给二维码，不编造邮箱/群号）', () => {
  const text = contactSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // 「邮箱」与「邮件」都得拦：只拦前者时，写「邮件联系 xxx@yyy.com」能完整绕过。
  assert.doesNotMatch(text, /mailto:|邮[箱件]|e-?mail/i, '文案不应出现邮箱/邮件渠道（用户确认仅二维码）');
  assert.doesNotMatch(text, /[\w.+-]@[\w-]+\.[a-z]{2,}/i, '文案不应出现任何邮箱地址形态');
});

/* ---------------- 卫生 ---------------- */

test('新增源码行尾统一、无 BOM、无残留变异标记', () => {
  const stat = file => {
    const b = fs.readFileSync(path.join(siteRoot, file));
    let lf = 0, crlf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) { lf++; if (i > 0 && b[i - 1] === 13) crlf++; }
    return { lf, crlf, bare: lf - crlf, bom: b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf };
  };
  for (const f of ['index.html', 'models.html', 'css/styles.css', 'js/main.js']) {
    const s = stat(f);
    assert.ok(s.bare === 0 || s.crlf === 0, `${f} 行尾混用（CRLF=${s.crlf} 裸LF=${s.bare}）`);
    assert.equal(s.bom, false, `${f} 不应有 BOM`);
  }
  for (const s of [indexHtml, css, mainJs, modelsHtml]) {
    assert.ok(!s.includes('MUTANT'), '不应残留变异标记');
  }
});

test('下载清单异步撑高后必须按 hash 重对齐（否则窄屏 #contact 停在 opacity:0）', () => {
  // 签名要精确到括号：只查「函数名出现」会被 setupHashRealignOLD 这种改名骗过（前缀匹配）
  const sigAt = mainJs.indexOf('function setupHashRealign() {');
  assert.ok(sigAt >= 0, 'main.js 必须有 setupHashRealign() 定义：#downloadGrid 由异步清单渲染，实测撑高 174~659px，会把下载区下方的区块整体推走，而浏览器不做补偿');
  const def = mainJs.slice(sigAt, mainJs.indexOf('\n}', sigAt));
  assert.ok(def.length > 80, 'setupHashRealign 函数体应完整（未找到闭合）');
  assert.match(def, /location\.hash/, '必须按原 hash 定位：这是「异步撑高区域下方所有区块」的通用问题，写死区块 id 护不住以后新增的区块');

  // 必须是真实调用语句。注释里同样写着 scrollIntoView / userScrolled，
  // 只断言「这个词存在」等于恒绿——删掉代码保留注释照样过（本轮变异实测复现）。
  assert.match(def, /if \(el\) el\.scrollIntoView\(\);/, '必须真的调用 scrollIntoView（与 scroll-margin-top 同一口径），换成别的动作等于没修');
  assert.match(def, /if \(userScrolled\) return;/, '必须真正拦截：用户自己滚过时不得劫持阅读位置');

  // 空操作化防御：在 realign 内写一句 userScrolled = true 就能让整套机制静默失效，
  // 而上面所有「词存在」型断言全都还是绿的。
  const realignBody = def.slice(def.indexOf('return function realign'));
  assert.ok(realignBody.length > 20, '应能定位到 realign 返回体');
  assert.doesNotMatch(realignBody, /userScrolled\s*=[^=]/, 'realign 内不得改写 userScrolled（置 true 会让重对齐永远跳过）');

  // 接线顺序：守卫要在清单请求发出前绑定，重对齐要在 DOM 变更完成后触发
  const bootAt = mainJs.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(bootAt > sigAt, 'setupHashRealign 应定义在启动段之前');
  const boot = mainJs.slice(bootAt);
  const bindAt = boot.indexOf('setupHashRealign()');
  const fetchAt = boot.indexOf('loadDownloadsManifest()');
  assert.ok(bindAt >= 0, '启动段必须绑定守卫');
  assert.ok(bindAt < fetchAt, '守卫须在清单请求发出前绑定，否则等待期间的用户滚动记录不到');
  const renderAt = boot.indexOf('renderDownloads(manifest);');
  const ctaAt = boot.indexOf('setupHeroCta(manifest);');
  const callAt = boot.indexOf('realignAfterDownloads()');
  assert.ok(renderAt >= 0 && ctaAt > renderAt && callAt > ctaAt,
    '重对齐必须在 renderDownloads / setupHeroCta 之后触发（同一 then 回调内），早于布局变化则等于没修');
});

test('联系项标题必须与说明分行：inline 会和说明连读成一句话', () => {
  const b = ruleBody('.contact-item b');
  assert.match(b, /display:\s*block/, '「使用答疑」这类标题应独占一行');

  // 必须要求「所有」条目都分离。上一版写成 match(/<b>[^<]+<\/b>[ \t]+\S/)，
  // 而联系项有 3 条兄弟节点——只破坏第 1 条时另外 2 条仍匹配，断言照样绿（变异实测复现）。
  // 存在型断言在多兄弟结构下必然漏检，这里反向断言「粘连的数量为 0」。
  const titles = contactSection.match(/<b>[^<]+<\/b>/g) || [];
  assert.ok(titles.length >= 3, `联系项应有 3 条标题，实得 ${titles.length}，本用例前提已变`);
  const glued = contactSection.match(/<b>[^<]+<\/b>[^\s<]/g) || [];
  assert.equal(glued.length, 0, `标题与说明粘连（</b> 后无空白）共 ${glued.length} 处：${JSON.stringify(glued)}`);
});

test('两张码都不得 lazy 加载：它们处在被异步撑高的锚点路径上', () => {
  const tags = contactSection.match(/<img\b[^>]*>/g) || [];
  assert.equal(tags.length, 2, '前提：联系区应有两张码；数量变了本用例需重审');
  for (const tag of tags) {
    assert.doesNotMatch(tag, /loading="lazy"/, 'lazy 图位于下载区下方：清单异步撑高后它才进入视口，到场时间不可控；且本页其余 img 都不写 loading');
  }
});

test('联系面板圆角沿用全站令牌，不做局部孤例', () => {
  // 必须从 .contact-panel 规则体内取，不能用三行组合匹配：
  // .feature-card 有完全相同的 background + backdrop-filter 组合，字符串匹配会命中 2 处。
  const panel = ruleBody('.contact-panel');
  assert.match(panel, /border-radius:\s*var\(--radius\)\s*;/, '与相邻 .feature-card / .step-card 同口径');
  assert.doesNotMatch(panel, /border-radius:\s*calc/, '不应保留 calc 孤例（全站仅此一处会显得突兀）');
});

test('畸形 hash 不得打断整页启动（decodeURIComponent 会抛 URIError）', () => {
  // setupHashRealign 在 DOMContentLoaded 回调首行被调用。实测 #%zz 会让 decodeURIComponent
  // 抛 URIError，连带把 reveal 接线、导航高亮、下载区渲染全部拖垮（downloadGrid 子节点停在 1）。
  const at = mainJs.indexOf('function setupHashRealign() {');
  assert.ok(at >= 0, '缺少 setupHashRealign');
  const def = mainJs.slice(at, mainJs.indexOf('\n}', at));
  assert.match(def, /try\s*\{/, '解码必须包在 try 内');
  assert.match(def, /catch \(e\) \{[\r\n\s]*return null;/, 'catch 后应放弃本次重对齐并返回 null（退化成修复前行为，而不是抛出）');
  assert.ok(def.indexOf('try {') < def.indexOf('userScrolled'), '解码防御须在绑定滚动守卫之前，保证异常路径不留半初始化的监听器');
});