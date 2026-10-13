/**
 * 契约测试：联系方式区的「双码」形态（客服 QQ + 官方 QQ 群）与导航入口顺序。
 *
 * 为什么单独立一个文件：contact-block-contract.test.js 里所有与图片相关的断言
 * 都是 `contactSection.match(/<img\b[^>]*>/)[0]` —— 只取第一张。区块从单码变双码后，
 * 第二张码（qr-group.png）处于「零覆盖」状态：文件不存在、被换成原图（极性反转）、
 * 尺寸属性写错，全部测不出来。本文件把每一条图片约束都改成对「全部 <img>」参数化。
 *
 * 另守两件真实风险：
 *   A. 群码原图是「深灰底 + 浅蓝码点」的极性反转码（实测 71.8% 像素为 rgb(38,38,38)，
 *      最亮点仅 195）。扫码器默认深码浅底，反转码会被拒识，所以入库图必须是白底深码。
 *   B. 用户要求「联系」排在「模型网关」之后。site-nav-contract.test.js 的夹具是自己
 *      new 出来的 4 个 anchor（anchors[3] 硬编码下标），完全不读真实 HTML，
 *      所以真实导航顺序在那份测试里属于盲区 —— 由本文件的字符串断言补守。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const siteRoot = path.resolve(__dirname, '../../../../gourd-ai-website');
const readSite = (...p) => fs.readFileSync(path.join(siteRoot, ...p), 'utf8').replace(/^\uFEFF/, '');

const indexHtml = readSite('index.html');
const modelsHtml = readSite('models.html');
const css = readSite('css', 'styles.css');

const { decodePng, measureQr, quietModulesAfterRender, lumOf } = require('./lib/png-qr-metrics.js');

/* 两张码都必须满足同一套约束 —— 遍历而非取首个，杜绝「只测第一张」。 */
const QR_ASSETS = ['assets/qr-contact.png', 'assets/qr-group.png'];

const contactSection = (() => {
  const at = indexHtml.indexOf('id="contact"');
  assert.ok(at >= 0, 'index.html 必须有 id="contact"');
  return indexHtml.slice(indexHtml.lastIndexOf('<section', at), indexHtml.indexOf('</section>', at));
})();

/** 剥离注释后按选择器取规则体（与 contact-block-contract 同口径，避免命中说明文字）。 */
function ruleBody(selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = stripped.match(new RegExp(`(?:^|[\\s,{}])${esc}\\s*\\{`, 'm'));
  assert.ok(m, `styles.css 应存在规则「${selector}」`);
  const start = stripped.indexOf('{', m.index + m[0].length - 1) + 1;
  let depth = 1, i = start;
  while (i < stripped.length && depth > 0) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
    i++;
  }
  assert.equal(depth, 0, `规则「${selector}」花括号未配平`);
  return stripped.slice(start, i - 1);
}

/* ---------------- 双码结构 ---------------- */

test('联系区必须恰好两张码，且每张各自成一项（用户新增 QQ 群，不是替换客服码）', () => {
  const imgs = contactSection.match(/<img\b[^>]*>/g) || [];
  assert.equal(imgs.length, 2, `应有 2 张二维码，实得 ${imgs.length}`);
  const srcs = imgs.map(t => (t.match(/src="([^"]+)"/) || [])[1]);
  for (const s of srcs) assert.ok(s, '每张码都必须有 src');
  assert.equal(new Set(srcs).size, 2, `两张码必须指向不同文件，实得 ${JSON.stringify(srcs)}`);
  for (const a of QR_ASSETS) {
    assert.ok(srcs.includes(a), `缺少 ${a} 的入口（漏一张=该渠道在页面上根本进不去）`);
  }
  assert.equal(contactSection.match(/class="qr-item"/g).length, 2, '每张码应有自己的 .qr-item 承载体');
  assert.equal(contactSection.match(/class="qr-card"/g).length, 2, '每张码必须各自坐在一张白卡里，不能共用');
});

test('两张码都真实存在、带 alt/width/height 且与 PNG 实际尺寸一致', () => {
  const imgs = contactSection.match(/<img\b[^>]*>/g) || [];
  assert.equal(imgs.length, 2, '前提：两张码');
  for (const tag of imgs) {
    const src = (tag.match(/src="([^"]+)"/) || [])[1];
    const abs = path.join(siteRoot, src);
    assert.ok(fs.existsSync(abs), `二维码文件不存在：${src}`);
    assert.doesNotMatch(src, /^https?:/, `不应外链第三方：${src}`);
    assert.match(tag, /alt="[^"]*QQ[^"]*"/, `alt 应说明是哪张 QQ 码：${src}`);
    const w = Number((tag.match(/\bwidth="(\d+)"/) || [])[1]);
    const h = Number((tag.match(/\bheight="(\d+)"/) || [])[1]);
    assert.ok(w > 0 && h > 0, `<img> 必须写 width/height（防布局跳动）：${src}`);
    const buf = fs.readFileSync(abs);
    assert.equal(buf.slice(1, 8).toString('hex'), '504e470d0a1a0a', `${src} 必须是合法 PNG`);
    assert.equal(buf.readUInt32BE(16), w, `${src} 的 width 属性与真实像素宽不符`);
    assert.equal(buf.readUInt32BE(20), h, `${src} 的 height 属性与真实像素高不符`);
    // 两张码都得是「非 lazy」：它们都在被异步清单撑高的锚点路径上
    assert.doesNotMatch(tag, /loading="lazy"/, `${src} 不得 lazy 加载`);
  }
});

/* ---------------- 群码极性（本轮核心风险） ---------------- */

test('两张码都必须是「白底 + 深码」正常极性：原群码是反色码，直接贴会被扫码器拒识', () => {
  for (const rel of QR_ASSETS) {
    const img = decodePng(fs.readFileSync(path.join(siteRoot, rel)));
    let minL = 255, maxL = 0, light = 0, dark = 0, opaque = 0;
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        const l = lumOf(img, x, y);
        if (l < minL) minL = l;
        if (l > maxL) maxL = l;
        if (l > 200) light++; else if (l < 128) dark++;
        if (img.ch === 4 && img.data[y * img.stride + x * img.ch + 3] === 255) opaque++;
      }
    }
    const total = img.w * img.h;
    assert.equal(opaque, total, `${rel} 必须全图不透明（透明像素会让深色透出吃掉对比度）`);
    assert.ok(maxL - minL >= 120, `${rel} 明度差仅 ${(maxL - minL).toFixed(0)}，低于扫码安全线 120`);
    // 极性判据：白底码的「亮像素」必须显著多于「暗像素」。
    // 原群码反过来（暗 78.6% / 亮 0%），这一条就是专门拦它被重新引入。
    assert.ok(light > dark, `${rel} 极性可疑：亮像素 ${light} <= 暗像素 ${dark}，像是深底浅码（反色码）`);
    assert.ok(light / total > 0.4, `${rel} 白底占比仅 ${(light / total * 100).toFixed(1)}%，不足以形成白底二维码`);
    assert.ok(minL < 100, `${rel} 码点应足够深（minLum=${minL.toFixed(0)}）`);
    assert.ok(maxL > 240, `${rel} 底色应接近纯白（maxLum=${maxL.toFixed(0)}）`);
  }
});

test('两张码静区都必须靠卡片 padding 补到 >=4 模块（QR 规范下限）', () => {
  const base = {
    displayWidth: Number((ruleBody('.qr-card img').match(/width:\s*(\d+)px/) || [])[1]),
    padding: Number((ruleBody('.qr-card').match(/padding:\s*(\d+)px/) || [])[1]),
  };
  assert.ok(base.displayWidth && base.padding, '应能从基础规则读出 img 显示宽与卡片 padding');
  const mobileBlock = (css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*?\n\}/) || [])[0];
  assert.ok(mobileBlock, '应保留 767px 断点');
  const mobile = {
    displayWidth: Number((mobileBlock.match(/\.qr-card img \{ width: (\d+)px;/) || [])[1]),
    padding: Number((mobileBlock.match(/\.qr-card \{ padding: (\d+)px;/) || [])[1]),
  };
  assert.ok(mobile.displayWidth && mobile.padding, '767px 断点应同时给出 padding 与显示宽');

  for (const rel of QR_ASSETS) {
    const m = measureQr(decodePng(fs.readFileSync(path.join(siteRoot, rel))));
    assert.ok(m.quietModulesInImage < 4,
      `前提已变：${rel} 图内静区达 ${m.quietModulesInImage.toFixed(2)} 模块，不再依赖 padding，应重审本用例`);
    const desktop = quietModulesAfterRender(m, base.displayWidth, base.padding);
    assert.ok(desktop >= 4, `${rel} 桌面最终静区仅 ${desktop.toFixed(2)} 模块，低于 4 会扫不出来`);
    const mob = quietModulesAfterRender(m, mobile.displayWidth, mobile.padding);
    assert.ok(mob >= 4, `${rel} 窄屏最终静区仅 ${mob.toFixed(2)} 模块，手机扫码会被拒`);
  }
});

/* ---------------- 双码并排的版式健壮性 ---------------- */

test('.contact-qr 必须允许换行：两张码并排，写死 nowrap 会溢出容器', () => {
  const body = ruleBody('.contact-qr');
  assert.match(body, /display:\s*flex/, '双码应用 flex 横排');
  assert.match(body, /flex-wrap:\s*wrap/, '必须可换行：面板列宽随视口变化，两张码放不下时要自动折行而不是撑破');
  assert.doesNotMatch(body, /flex-wrap:\s*nowrap|white-space:\s*nowrap/, '不得禁止换行');
  const item = ruleBody('.qr-item');
  assert.match(item, /min-width:\s*0/, '.qr-item 必须 min-width:0，否则 flex 子项不收缩');
  assert.match(item, /flex-direction:\s*column/, '每张码的卡片与说明应纵向成组');
});

test('两张码并排必须放得下，且文案列不被挤没（数值取自 CSS，不用魔数）', () => {
  // 从 CSS 读实际版式参数（不拍脑袋写死像素）
  const card = Number((ruleBody('.qr-card').match(/padding:\s*(\d+)px/) || [])[1]);
  const disp = Number((ruleBody('.qr-card img').match(/width:\s*(\d+)px/) || [])[1]);
  const gap = Number((ruleBody('.contact-qr').match(/gap:\s*[\d.]+px\s+([\d.]+)px/) || [])[1]);
  const panelPad = Number((ruleBody('.contact-panel').match(/padding:\s*\d+px\s+(\d+)px/) || [])[1]);
  const panelGap = Number((ruleBody('.contact-panel').match(/gap:\s*[\d.]+px\s+([\d.]+)px/) || [])[1]);
  const container = Number((css.match(/\.container\s*\{[^}]*max-width:\s*(\d+)px/) || [])[1]);
  const containerPad = Number((css.match(/\.container\s*\{[^}]*padding:\s*0\s+(\d+)px/) || [])[1]);
  assert.ok([card, disp, gap, panelPad, panelGap, container, containerPad].every(Number.isFinite),
    '版式参数应全部可从 CSS 读出（读不到说明选择器/写法变了，本用例前提失效）');

  // 最窄的「双栏」视口：1023px 断点以下转单栏，故 1024 是双栏最窄档
  const inner = Math.min(container, 1024) - 2 * containerPad - 2 * panelPad;
  const twoCards = 2 * (disp + 2 * card) + gap;
  const qrCol = inner - panelGap;
  assert.ok(twoCards <= qrCol,
    `两张码并排需 ${twoCards}px，联系列在最窄双栏视口只有 ${qrCol}px —— 右码会被挤掉或溢出`);

  // 文案列在并排后仍要可读（窄栏里长词会换行成「竖排」，故设硬下限）
  const copyCol = inner - panelGap - twoCards;
  assert.ok(copyCol >= 320,
    `并排后文案列只剩 ${copyCol}px，联系理由会被压成一列窄条（应 >=320px）`);

  // 单卡在最窄手机视口不得溢出（此时 wrap 已把两卡折成堆叠）
  const m767 = (css.match(/@media \(max-width: 767px\)\s*\{[\s\S]*?\n\}/) || [])[0];
  const mCard = Number((m767.match(/\.qr-card \{ padding: (\d+)px;/) || [])[1]);
  const mImg = Number((m767.match(/\.qr-card img \{ width: (\d+)px;/) || [])[1]);
  const mPanel = Number((m767.match(/\.contact-panel \{ padding: \d+px (\d+)px;/) || [])[1]);
  const narrowInner = 320 - 2 * containerPad - 2 * mPanel;
  assert.ok(mImg + 2 * mCard <= narrowInner,
    `窄屏单卡需 ${mImg + 2 * mCard}px > 面板内宽 ${narrowInner}px，320px 视口会横向溢出`);
});

/* ---------------- 导航顺序（用户本轮要求） ---------------- */

/** 取某个 HTML 里 navLinks 的 <a> 序列（文本或域名标识）。 */
function navItems(html) {
  const at = html.indexOf('id="navLinks"');
  assert.ok(at >= 0, '应有 navLinks');
  const nav = html.slice(at, html.indexOf('</nav>', at));
  return (nav.match(/<a\b[^>]*>([^<]*)<\/a>/g) || []).map(t => {
    const inner = t.replace(/<a\b[^>]*>/, '').replace(/<\/a>/, '');
    const href = (t.match(/href="([^"]+)"/) || [])[1] || '';
    return { text: inner, href };
  });
}

for (const [label, html, contactHref] of [
  ['index.html', indexHtml, '#contact'],
  ['models.html', modelsHtml, 'index.html#contact'],
]) {
  test(`${label} 顶栏「联系」必须紧跟在「模型网关」之后`, () => {
    const items = navItems(html);
    assert.ok(items.length >= 5, `${label} 顶栏应至少 5 项，实得 ${items.length}`);
    const gi = items.findIndex(a => a.href.includes('api.gourdwork.com'));
    const ci = items.findIndex(a => a.href === contactHref && a.text.includes('\u8054\u7cfb'));
    assert.ok(gi >= 0, `${label} 顶栏应有「模型网关」外链`);
    assert.ok(ci >= 0, `${label} 顶栏应有「联系」项（href=${contactHref}）`);
    assert.equal(ci, gi + 1,
      `${label} 顶栏顺序应为「…模型网关 → 联系」，实得 模型网关#${gi} 联系#${ci}（联系必须紧随其后）`);
  });
}

test('页脚联系入口不受导航换序影响，且顺序无需跟随（外链不在页脚）', () => {
  const foot = indexHtml.slice(indexHtml.indexOf('<footer'));
  assert.match(foot, /<a href="#contact">[^<]*联系/, 'index 页脚仍应有联系入口');
  assert.equal((indexHtml.match(/href="#contact"/g) || []).length, 2, '顶栏 + 页脚各一处');
  assert.equal((modelsHtml.match(/href="index\.html#contact"/g) || []).length, 2, 'models 两枚跨页入口，防两页漂移');
});

/* ---------------- 文案口径 ---------------- */

test('联系文案不得出现邮箱：邮箱不在用户给定的渠道内（QQ 客服 + QQ 群）', () => {
  const text = contactSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /mailto:|邮[箱件]|e-?mail/i, '文案不应出现邮箱/邮件渠道');
  assert.doesNotMatch(text, /[\w.+-]@[\w-]+\.[a-z]{2,}/i, '文案不应出现任何邮箱地址形态');
});

test('联系文案可写渠道名，但不得写死具体号码（群号/QQ 号会过期且我无法核实）', () => {
  const text = contactSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // 上一版这里禁的是「QQ群」这个词，但用户本轮就要加 QQ 群；且它靠 \d{8,} 才真正起作用——
  // 词禁令被一个空格（「QQ 群」）就能绕过，属假护栏。改为只拦号码，词不再拦。
  assert.doesNotMatch(text, /\d{5,}/, `文案不应出现任何 5 位以上数字（号码），实得片段：${JSON.stringify((text.match(/\d{5,}/g) || []))}`);
  assert.ok(/QQ/.test(text), '渠道应说明是 QQ（客服与群）');
});
