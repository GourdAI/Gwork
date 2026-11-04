// 移动端 H5 逐页探针 v4：直接 hash 跳各 Tab 页，逐页截图 + 几何量测 + 越界检测。
const { chromium } = require('D:/work/gourd/gourdai/.tmp/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/work/gourd/gourdai/gourd-work-app/.tmp_mobile_probe';
const BASE = 'http://127.0.0.1:5173';

const PAGES = [
  ['tasks', '/#/pages/tasks/tasks'],
  ['loop', '/#/pages/loop/loop'],
  ['discover', '/#/pages/discover/discover'],
  ['mine', '/#/pages/mine/mine'],
  ['sessions', '/#/pages/sessions/sessions'],
  ['hosts', '/#/pages/hosts/hosts'],
  ['settings', '/#/pages/settings/settings'],
  ['chat', '/#/pages/chat/chat'],
  ['pair', '/#/pages/pair/pair'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: 'C:/Users/LUZW/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push('[' + m.type() + '] ' + m.text().slice(0, 240)); });
  page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 300)));

  for (const [name, hash] of PAGES) {
    logs.length = 0;
    await page.goto(BASE + hash, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('goto ' + e.message));
    await page.waitForTimeout(1600);
    const info = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const root = document.querySelector('.page-root');
      const tb = document.querySelector('.topbar');
      const pageEl = document.querySelector('uni-page');
      const all = Array.from(document.querySelectorAll('.page-root *'));
      const vis = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const overflowX = vis.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > vw + 1; })
        .slice(0, 8).map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className || '').slice(0, 46), l: Math.round(r.left), r: Math.round(r.right) }; });
      const negTop = vis.filter(el => el.getBoundingClientRect().top < -1).length;
      return {
        route: pageEl ? pageEl.getAttribute('data-page') : null,
        root: root ? { w: Math.round(root.getBoundingClientRect().width), h: Math.round(root.getBoundingClientRect().height) } : null,
        topbar: tb ? { top: Math.round(tb.getBoundingClientRect().top), h: Math.round(tb.getBoundingClientRect().height) } : null,
        vw, vh,
        scrollH: document.documentElement.scrollHeight,
        rootBg: root ? getComputedStyle(root).backgroundColor : null,
        overflowX,
        negTop,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 100),
      };
    });
    console.log('=== ' + name + ' ' + JSON.stringify(info));
    if (logs.length) { console.log('  LOGS:'); logs.slice(0, 5).forEach(l => console.log('   ' + l)); }
    await page.screenshot({ path: path.join(OUT, 'v4-' + name + '.png') });
  }
  await browser.close();
})();
