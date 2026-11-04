// 移动端 H5 逐页探针 v3：真实点击 tabBar / 路由跳转，逐页截图 + 几何量测。
const { chromium } = require('D:/work/gourd/gourdai/.tmp/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = 'D:/work/gourd/gourdai/gourd-work-app/.tmp_mobile_probe';
const BASE = 'http://127.0.0.1:5173';

// 先注入一个假连接，让应用认为已配对（否则会被 redirect 到配对页）
const SEED = `try {
  localStorage.setItem('gwork.connections', JSON.stringify([{id:'probe-1',name:'探针内核',host:'127.0.0.1',port:9,protocol:'http',authUser:'',authPass:'',lastConnected:0,version:''}]));
  localStorage.setItem('gwork.connections.active', 'probe-1');
} catch(e) {}`;

const TABS = [
  ['tasks', '任务'],
  ['loop', '定时任务'],
  ['discover', '发现'],
  ['mine', '我的'],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: 'C:/Users/LUZW/AppData/Local/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-win64/chrome-headless-shell.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(SEED);
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text().slice(0, 300)));
  page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 400)));

  await page.goto(BASE + '/#/pages/tasks/tasks', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => logs.push('goto ' + e.message));
  await page.waitForTimeout(1800);

  const probe = async (label) => {
    const info = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const root = document.querySelector('.page-root');
      const tb = document.querySelector('.topbar');
      const all = Array.from(document.querySelectorAll('.page-root *'));
      const vis = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const overflow = vis.filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < -1 || r.right > vw + 1;
      }).slice(0, 10).map(el => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className || '').slice(0, 50), l: Math.round(r.left), r: Math.round(r.right) }; });
      return {
        page: (document.querySelector('uni-page') || {}).getAttribute?.('data-page') || null,
        rootRect: root ? { w: Math.round(root.getBoundingClientRect().width), h: Math.round(root.getBoundingClientRect().height) } : null,
        topbar: tb ? { top: Math.round(tb.getBoundingClientRect().top), h: Math.round(tb.getBoundingClientRect().height) } : null,
        vw, vh,
        scrollH: document.documentElement.scrollHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        rootBg: root ? getComputedStyle(root).backgroundColor : null,
        overflow,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
      };
    });
    console.log('=== ' + label);
    console.log(JSON.stringify(info));
    await page.screenshot({ path: path.join(OUT, 'v3-' + label + '.png') });
  };

  await probe('tasks');
  for (const [key, label] of TABS) {
    if (key === 'tasks') continue;
    await page.evaluate((lbl) => {
      const items = Array.from(document.querySelectorAll('.uni-tabbar__item'));
      const it = items.find(i => (i.innerText || '').includes(lbl));
      if (it) it.click();
    }, label);
    await page.waitForTimeout(1400);
    await probe(key);
  }

  // 子页
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.uni-tabbar__item'));
    const it = items.find(i => (i.innerText || '').includes('任务'));
    if (it) it.click();
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*')).filter(e => (e.innerText || '').trim() === '配对内核');
    if (els.length) els[0].click();
  });
  await page.waitForTimeout(1200);
  await probe('pair-via-nav').catch(() => {});

  console.log('\n=== LOGS (' + logs.length + ') ===');
  logs.slice(0, 40).forEach(l => console.log(l));
  fs.writeFileSync(path.join(OUT, 'v3-logs.json'), JSON.stringify(logs, null, 2));
  await browser.close();
})();
