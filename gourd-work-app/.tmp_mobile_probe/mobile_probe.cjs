// 移动端 H5 真机视口探针：逐页截图 + 几何量测，定位「页面错乱」形态。
// 用 playwright-core + 本机 chrome（headless shell 亦可）。
const { chromium } = require('D:/work/gourd/gourdai/.tmp/node_modules/playwright-core');
const path = require('path');
const fs = require('fs');

const OUT = 'D:/work/gourd/gourdai/.tmp_mobile_probe';
const BASE = 'http://127.0.0.1:5173';

const PAGES = [
  ['tasks', '/#/pages/tasks/tasks'],
  ['sessions', '/#/pages/sessions/sessions'],
  ['loop', '/#/pages/loop/loop'],
  ['discover', '/#/pages/discover/discover'],
  ['mine', '/#/pages/mine/mine'],
  ['pair', '/#/pages/pair/pair'],
  ['hosts', '/#/pages/hosts/hosts'],
  ['settings', '/#/pages/settings/settings'],
  ['chat', '/#/pages/chat/chat'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: 'C:/Users/LUZW/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e).slice(0, 300)));

  const report = [];
  for (const [name, hash] of PAGES) {
    await page.goto(BASE + hash, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => errors.push(name + ' goto: ' + e.message));
    await page.waitForTimeout(1200);
    const info = await page.evaluate(() => {
      const root = document.querySelector('.page-root') || document.body;
      const topbar = document.querySelector('.topbar');
      const all = Array.from(document.querySelectorAll('*'));
      const vis = all.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.offsetParent !== null;
      });
      // 越界元素（超出视口）
      const vw = window.innerWidth, vh = window.innerHeight;
      const overflow = vis.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < -1 || r.right > vw + 1 || r.top < -1;
      }).slice(0, 12).map(el => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) };
      });
      const tb = topbar ? topbar.getBoundingClientRect() : null;
      return {
        title: document.title,
        rootRect: root ? { w: root.getBoundingClientRect().width, h: root.getBoundingClientRect().height, top: root.getBoundingClientRect().top } : null,
        topbar: tb ? { top: Math.round(tb.top), h: Math.round(tb.height), left: Math.round(tb.left), right: Math.round(tb.right) } : null,
        viewport: { w: vw, h: vh },
        scrollH: document.documentElement.scrollHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        rootBg: root ? getComputedStyle(root).backgroundColor : null,
        overflowCount: overflow.length,
        overflow,
        textSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
        childCount: all.length,
      };
    });
    report.push({ name, hash, info });
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
    console.log('=== ' + name);
    console.log(JSON.stringify(info, null, 1));
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ report, errors }, null, 2));
  console.log('\nERRORS=' + errors.length);
  errors.slice(0, 30).forEach(e => console.log(e));
  await browser.close();
})();
