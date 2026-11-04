// H5 真机视口探针 v2：拿运行时错误 + 应用 HTML + 各页截图。
const { chromium } = require('D:/work/gourd/gourdai/.tmp/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/work/gourd/gourdai/gourd-work-app/.tmp_mobile_probe';
const BASE = 'http://127.0.0.1:5173';

const PAGES = [
  ['tasks', '/#/pages/tasks/tasks'],
  ['pair', '/#/pages/pair/pair'],
  ['sessions', '/#/pages/sessions/sessions'],
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
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text().slice(0, 400)));
  page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 600)));

  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('goto ' + e.message));
  await page.waitForTimeout(2000);
  const appHtml = await page.evaluate(() => {
    const app = document.querySelector('#app');
    return app ? app.innerHTML.slice(0, 2000) : '(no #app)';
  });
  console.log('=== APP HTML ===');
  console.log(appHtml);
  console.log('=== LOGS (' + logs.length + ') ===');
  logs.slice(0, 40).forEach(l => console.log(l));
  await page.screenshot({ path: path.join(OUT, 'v2-root.png') });

  for (const [name, hash] of PAGES) {
    await page.goto(BASE + hash, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push(name + ' goto ' + e.message));
    await page.waitForTimeout(1500);
    const n = logs.length;
    console.log('=== ' + name + ' logs +' + n);
    logs.slice(-12).forEach(l => console.log(l));
    await page.screenshot({ path: path.join(OUT, 'v2-' + name + '.png') });
  }
  fs.writeFileSync(path.join(OUT, 'v2-logs.json'), JSON.stringify(logs, null, 2));
  await browser.close();
})();
