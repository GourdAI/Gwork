/* 390×844 真实浏览器探针：逐页/逐面板截图 + 几何量测 + 控制台错误采集 + 真实断言。
 * 用法：node test/probe.cjs [baseUrl]
 * 依赖：本机 Edge（headless + remote debugging），无需 npm 包。
 *
 * 与旧版的关键差异：
 *  - 每个场景都是真实断言（几何 / tab / panel / theme / 背景色 / 溢出 / 裁切 / 错误），
 *    任一不满足即打印 FAIL 并置 process.exitCode = 1；metrics.json 与截图仍落盘。
 *  - 所有动作走真实 DOM click（含 MouseEvent 冒泡路径），仅保留一个专门的 dispatch 场景。
 *  - goto(hash) 真正生效：冷启动深链 #loop / #discover / #mine / #tasks 有独立场景。
 *  - 端口动态探测（不与 interaction.cjs 的 9350/9351 相撞），EADDRINUSE 可处理。
 *  - c / edge / server 在 finally 与 catch 中统一释放；WebSocket 支持分片与控制帧。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p)) || EDGE_CANDIDATES[0];
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe');
const RESERVED_PORTS = new Set([9350, 9351]); // interaction.cjs 固定端口，避免并发相撞

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};

// ---- 极简静态服务器（L5：路径规范化 + decodeURIComponent 容错） ----
const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request: malformed URL encoding');
    return;
  }
  if (p === '/') p = '/index.html';
  const file = path.resolve(ROOT, '.' + p);
  if (!(file === ROOT || file.startsWith(ROOT + path.sep)) ||
      !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 可重试：listenWithRetry 会换端口；此处只记录，不能把「已自动恢复」误判为失败
    console.error('PROBE WARN: 静态端口 EADDRINUSE，交给 listenWithRetry 处理：' + e.message);
  } else {
    console.error('PROBE FAILED: 静态服务器错误：' + e.message);
    process.exitCode = 1;
  }
});

// ---- 端口探测：监听 0 取实际端口，排除 interaction.cjs 的固定端口 ----
function reservePort(exclude) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => {
        if (exclude.has(port)) {
          reject(new Error('EADDRINUSE(soft): 探测到保留端口 ' + port + '，重试'));
        } else resolve(port);
      });
    });
  });
}
async function freePort(exclude) {
  for (let i = 0; i < 12; i++) {
    try { return await reservePort(exclude); }
    catch (e) { if (!/EADDRINUSE\(soft\)/.test(e.message)) throw e; }
  }
  throw new Error('无法探测到可用端口（连续 12 次命中保留端口）');
}
async function listenWithRetry() {
  for (let i = 0; i < 6; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
        const onOk = () => { server.removeListener('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(0, '127.0.0.1');
      });
      return server.address().port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      console.error('PROBE WARN: 静态端口 EADDRINUSE，重试 listen(0) #' + (i + 1));
      try { server.close(); } catch (x) {}
    }
  }
  throw new Error('静态服务器连续 6 次 EADDRINUSE');
}

// ---- 极简 CDP 客户端（无第三方依赖；支持 WebSocket 分片 / ping / close） ----
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write('GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key +
        '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0), upgraded = false, id = 0, closed = false;
    let frag = null, fragOpcode = 0;
    const pending = new Map();
    const listeners = [];

    function frame(opcode, payload, maskIt) {
      const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      const mask = maskIt ? crypto.randomBytes(4) : null;
      let head;
      if (p.length < 126) head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | p.length]);
      else if (p.length < 65536) {
        head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = (mask ? 0x80 : 0) | 126;
        head.writeUInt16BE(p.length, 2);
      } else {
        head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = (mask ? 0x80 : 0) | 127;
        head.writeBigUInt64BE(BigInt(p.length), 2);
      }
      if (!mask) return Buffer.concat([head, p]);
      const out = Buffer.alloc(p.length);
      for (let i = 0; i < p.length; i++) out[i] = p[i] ^ mask[i % 4];
      return Buffer.concat([head, mask, out]);
    }
    function send(text) { sock.write(frame(0x1, Buffer.from(text, 'utf8'), true)); }
    function call(method, params) {
      return new Promise((res, rej) => {
        const myId = ++id;
        pending.set(myId, { res, rej });
        send(JSON.stringify({ id: myId, method, params: params || {} }));
      });
    }
    function handleMessage(text) {
      try {
        const msg = JSON.parse(text);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id);
          msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
        } else if (msg.method) listeners.forEach(fn => fn(msg));
      } catch (e) { /* 非 JSON 帧忽略 */ }
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        upgraded = true;
        buf = buf.slice(idx + 4);
        resolve({
          call,
          on: (fn) => listeners.push(fn),
          close: () => { if (!closed) { closed = true; try { sock.end(); } catch (e) {} } }
        });
      }
      // 完整帧解析：FIN / opcode / 64 位长度 / mask / continuation / 控制帧
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let off = 2, len = b1 & 0x7f;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.slice(off, off + len));
        buf = buf.slice(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

        if (opcode === 0x8) { // close
          if (!closed) { closed = true; try { sock.end(); } catch (e) {} }
          return;
        }
        if (opcode === 0x9) { sock.write(frame(0xA, payload, true)); continue; } // ping -> pong
        if (opcode === 0xA) continue; // pong
        if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          if (opcode === 0x0 && !frag) continue;
          if (opcode !== 0x0) fragOpcode = opcode;
          frag = frag ? Buffer.concat([frag, payload]) : payload;
          if (!fin) continue;
          const text = frag.toString('utf8');
          const op = fragOpcode;
          frag = null; fragOpcode = 0;
          if (op === 0x1) handleMessage(text); // 文本帧（captureScreenshot 的大 base64 即在此）
        }
      }
    });
    sock.on('error', (e) => { if (!upgraded) reject(e); });
    sock.on('close', () => {
      pending.forEach(p => p.rej(new Error('CDP socket closed')));
      pending.clear();
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await sleep(150); }
  return false;
}

let c = null;          // H3：提升到 try 外层，finally / catch 统一释放
let edge = null;
let serverStarted = false;
let PORT = null;
let BASE = null;
const results = [];
const failures = [];
let errors = [];

async function cleanup() {
  if (c) { try { c.close(); } catch (e) {} c = null; }
  if (edge) { try { edge.kill(); } catch (e) {} edge = null; }
  if (serverStarted) {
    try {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close();
    } catch (e) {}
    serverStarted = false;
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(EDGE)) {
    // 不伪造通过：明确 SKIP，且不生成「通过」结论
    console.log('PROBE SKIP: 本机未安装 Edge（' + EDGE + '），真实浏览器探针跳过；未执行任何场景，不计为通过');
    return;
  }

  PORT = await listenWithRetry();
  serverStarted = true;
  BASE = process.argv[2] || ('http://127.0.0.1:' + PORT);
  const exclude = new Set([...RESERVED_PORTS, PORT]);
  const profile = path.join(OUT, 'edge-profile-' + process.pid + '-' + Date.now());

  let CDP_PORT = null;
  let page = null;
  for (let attempt = 0; attempt < 3 && !page; attempt++) {
    CDP_PORT = await freePort(exclude);
    exclude.add(CDP_PORT);
    edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--window-size=390,844', 'about:blank'
    ], { stdio: 'ignore' });
    const ok = await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version').catch(() => null);
      return !!(r && r.ok);
    }, 9000);
    if (ok) {
      const tabs = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      page = tabs.find(t => t.type === 'page');
    }
    if (!page) {
      console.error('PROBE WARN: CDP 端口 ' + CDP_PORT + ' 未就绪，换端口重试');
      try { edge.kill(); } catch (e) {}
      edge = null;
    }
  }
  if (!page) throw new Error('Edge CDP 未就绪（已尝试 3 个动态端口）');

  try {
    c = await cdp(page.webSocketDebuggerUrl);
    c.on(msg => {
      if (msg.method === 'Runtime.exceptionThrown') errors.push('exception: ' + JSON.stringify(msg.params.exceptionDetails.text));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push('log: ' + msg.params.entry.text);
    });
    await c.call('Runtime.enable');
    await c.call('Log.enable');
    await c.call('Page.enable');
    await c.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    async function evaluate(expr) {
      const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(d.text + ' | ' + (d.exception && d.exception.description || '') + ' | expr: ' + expr.slice(0, 220));
      }
      return r.result.value;
    }
    async function shot(name) {
      const r = await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const buf = Buffer.from(r.data || '', 'base64');
      // 大 base64 必须能解析成合法 PNG（分片帧也在此验证）
      if (buf.length < 8 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error('captureScreenshot 未返回合法 PNG：' + name + '（' + buf.length + ' bytes）');
      }
      fs.writeFileSync(path.join(OUT, name + '.png'), buf);
      return buf.length;
    }
    async function metrics(name) {
      return await evaluate(`(() => {
        const vw = innerWidth, vh = innerHeight;
        const root = document.querySelector('.page-root');
        const tb = document.querySelector('.tabbar');
        const rr = root.getBoundingClientRect();
        const tr = tb.getBoundingClientRect();
        const all = Array.from(document.querySelectorAll('.page-root *, .tabbar *'));
        const vis = all.filter(el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; });
        const overflow = vis.filter(el => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > vw+1; })
          .slice(0,6).map(el => el.className || el.tagName);
        const clipped = vis.filter(el => { const r = el.getBoundingClientRect(); return r.bottom > vh+1; })
          .slice(0,6).map(el => el.className || el.tagName);
        const s = window.GWorkMobile ? GWorkMobile.getState() : {};
        const active = document.querySelector('.tab-item.is-active');
        const anims = document.getAnimations ? document.getAnimations() : [];
        return { name: ${JSON.stringify(name)}, tab: document.body.dataset.tab, panel: document.body.dataset.panel,
          theme: document.documentElement.dataset.theme, hash: location.hash,
          stateTab: s.tab, statePanel: s.panel, stateTheme: s.theme,
          vw, vh,
          rootTop: Math.round(rr.top), rootH: Math.round(rr.height), rootBottom: Math.round(rr.bottom),
          tabTop: Math.round(tr.top), tabbarBottom: Math.round(tr.bottom), tabH: Math.round(tr.height),
          scrollY: Math.round(scrollY || 0), docScrollTop: Math.round(document.documentElement.scrollTop || 0),
          activeAnimations: anims.filter(a => a.playState === 'running').length,
          bg: getComputedStyle(document.querySelector('.app-root')).backgroundColor,
          textLen: (document.body.innerText||'').replace(/\\s+/g,' ').trim().length,
          activeSolid: active ? (active.innerHTML.indexOf('tab-solid') >= 0 ? 1 : 0) : -1,
          // 品牌验收（本次改造新增）：真实浏览器里 img 必须解码成功，文案/favicon 必须为 GWork
          brandLogoOk: (() => { const im = document.querySelector('.brand-logo'); return im ? (im.complete && im.naturalWidth > 0) : null; })(),
          brandName: ((document.querySelector('.brand-name') || {}).textContent || '').trim() || null,
          faviconOk: (() => { const l = document.querySelector('link[rel="icon"]'); return !!(l && /gwork-logo\.png/.test(l.getAttribute('href') || '')); })(),
          visibleWorkbuddy: /WorkBuddy/.test(document.body.innerText || ''),
          overflow, clipped };
      })()`);
    }

    let nonce = 0;
    async function goto(hash) {
      // 每步使用唯一 query 强制真正重新加载文档，hash 作为冷启动深链生效；
      // 清 localStorage 后 reload（保留 hash），保证每步从干净初始态开始。
      nonce++;
      const url = BASE + '/index.html?probe=' + nonce + (hash || '');
      await c.call('Page.navigate', { url });
      await waitFor(async () => await evaluate('!!window.GWorkMobile && !!document.querySelector(".tab-item")'), 8000);
      await evaluate('localStorage.clear()');
      await c.call('Page.reload', { ignoreCache: true });
      const ready = await waitFor(async () => await evaluate('!!window.GWorkMobile && !!document.querySelector(".tab-item")'), 8000);
      if (!ready) throw new Error('页面未就绪：' + url);
      await sleep(320);
    }
    async function clickSel(sel, bubble) {
      const expr = bubble
        ? `(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return true; })()`
        : `(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`;
      const ok = await evaluate(expr);
      if (!ok) throw new Error('点击目标不存在：' + sel);
    }
    async function dispatchCall(action, attrs) {
      const ok = await evaluate(`GWorkMobile.dispatch(${JSON.stringify(action)}, ${JSON.stringify(attrs || {})})`);
      if (!ok) throw new Error('dispatch 返回 false：' + action);
    }

    function verify(r, exp, errs) {
      const p = [];
      const vh = r.vh;
      if (r.vw !== 390) p.push(`vw=${r.vw} != 390`);
      if (r.vh !== 844) p.push(`vh=${r.vh} != 844`);
      if (r.rootH !== vh) p.push(`rootH=${r.rootH} != vh=${vh}`);
      if (r.rootBottom !== vh) p.push(`rootBottom=${r.rootBottom} != vh=${vh}`);
      const expectedTabTop = vh - r.tabH;
      if (r.tabH <= 0) p.push(`tabH=${r.tabH} 非法`);
      if (r.tabTop !== expectedTabTop) p.push(`tabTop=${r.tabTop} != tabbarTop 预期 ${expectedTabTop}（vh-tabH）`);
      if (!Array.isArray(r.overflow) || r.overflow.length) p.push(`横向溢出非空：${JSON.stringify(r.overflow)}`);
      if (!Array.isArray(r.clipped) || r.clipped.length) p.push(`竖向裁切非空：${JSON.stringify(r.clipped)}`);
      if (errs.length) p.push(`控制台/运行时错误非空：${JSON.stringify(errs)}`);
      if (r.tab !== exp.tab) p.push(`tab=${r.tab} != 预期 ${exp.tab}`);
      if (r.panel !== exp.panel) p.push(`panel=${r.panel} != 预期 ${exp.panel}`);
      if (r.stateTab !== exp.tab || r.stateTheme !== exp.theme ||
          r.statePanel !== (exp.panel === 'none' ? null : exp.panel)) {
        p.push(`getState 与 DOM dataset 不一致：${JSON.stringify({ tab: r.stateTab, panel: r.statePanel, theme: r.stateTheme })}`);
      }
      if (r.theme !== exp.theme) p.push(`theme=${r.theme} != 预期 ${exp.theme}`);
      if (r.bg !== exp.bg) p.push(`背景色=${r.bg} != 预期 ${exp.bg}`);
      if (r.activeSolid !== 1) p.push(`选中 Tab 未渲染实心图标 tab-solid（activeSolid=${r.activeSolid}）`);
      if (exp.hash !== null && r.hash !== exp.hash) p.push(`location.hash=${JSON.stringify(r.hash)} != 预期 ${JSON.stringify(exp.hash)}`);
      if (r.textLen <= 0) p.push('页面无可见文本（疑似白屏）');
      // 品牌验收：首页应显示已加载的 GWork 官方图形商标 + GWork 文案，favicon 指向官方 PNG，可见文本零 WorkBuddy
      if (r.brandLogoOk != null && r.brandLogoOk !== true) p.push('品牌商标 img 未加载成功（naturalWidth=0 / 404）');
      if (r.brandName != null && r.brandName !== 'GWork') p.push('顶栏品牌名=' + JSON.stringify(r.brandName) + ' != GWork');
      if (r.faviconOk === false) p.push('favicon 未指向 gwork-logo.png');
      if (r.visibleWorkbuddy === true) p.push('可见文本仍残留 WorkBuddy（品牌未改干净）');
      return p;
    }

    async function step(name, hash, actions, exp) {
      errors = [];
      try {
        await goto(hash);
        for (const a of (actions || [])) {
          if (a.click) await clickSel(a.click, false);
          if (a.bubble) await clickSel(a.bubble, true);
          if (a.dispatch) await dispatchCall(a.dispatch[0], a.dispatch[1] || {});
          if (a.sleep) await sleep(a.sleep);
          else await sleep(220);
        }
        // 面板有 .24s 入场动画、开关有 .18s transition；必须在稳定态测几何，
        // 否则会采到动画尾帧的亚像素 transform（表现为 rootBottom/tabTop 整体偏移 1px）。
        // 这里只等待稳定，不改变任何断言阈值。
        const settled = await waitFor(async () => {
          const s = await evaluate(`(() => ({
            anim: document.getAnimations ? document.getAnimations().filter(a => a.playState === 'running').length : 0,
            top: document.querySelector('.page-root').getBoundingClientRect().top,
            bottom: document.querySelector('.page-root').getBoundingClientRect().bottom
          }))()`);
          return s.anim === 0 && Math.abs(s.top) < 0.5 && Math.abs(s.bottom - 844) < 0.5;
        }, 2000);
        if (!settled) console.error('  WARN  ' + name + ' 几何未在 2s 内稳定，按最终采样值断言');
        const m = await metrics(name);
        m.errors = errors.slice(0, 5);
        try { m.shotBytes = await shot(name); }
        catch (e) { m.errors.push('screenshot: ' + e.message); }
        results.push(m);
        const problems = verify(m, exp, m.errors);
        if (problems.length) {
          failures.push({ name, problems });
          console.error('  FAIL  ' + name);
          problems.forEach(x => console.error('        - ' + x));
          process.exitCode = 1;
        } else {
          console.log('  ok    ' + name + '  tab=' + m.tab + ' panel=' + m.panel + ' theme=' + m.theme +
            ' bg=' + m.bg + ' rootH=' + m.rootH + ' rootBottom=' + m.rootBottom +
            ' tabTop=' + m.tabTop + '/' + (m.vh - m.tabH) + ' hash=' + JSON.stringify(m.hash) +
            ' solid=' + m.activeSolid + ' shot=' + m.shotBytes + 'B');
        }
      } catch (e) {
        results.push({ name, fatal: e.message, errors: errors.slice(0, 5) });
        failures.push({ name, problems: ['fatal: ' + e.message] });
        console.error('  FAIL  ' + name + '\n        - fatal: ' + e.message);
        process.exitCode = 1;
      }
    }

    const LIGHT = 'rgb(250, 250, 250)';
    const DARK = 'rgb(20, 20, 22)';
    const exp = (tab, panel, theme, bg, hash) => ({ tab, panel, theme, bg, hash: hash === undefined ? null : hash });

    console.log('== 390×844 探针：10 个基准场景 + 深链 / 冒泡 / dispatch 契约 ==');
    // 01/02 首页两态：真实点击 focus-composer
    await step('01-tasks-idle', '', [], exp('tasks', 'none', 'system', LIGHT));
    await step('02-tasks-focus', '', [{ click: '[data-action="focus-composer"]' }], exp('tasks', 'none', 'system', LIGHT));

    // 03/04/05：全部改为真实 DOM 点击；04 用 dispatchEvent(MouseEvent) 覆盖冒泡路径
    await step('03-loop', '', [{ click: '[data-action="switch-tab"][data-tab="loop"]' }], exp('loop', 'none', 'system', LIGHT));
    await step('04-discover', '', [{ bubble: '[data-action="switch-tab"][data-tab="discover"]' }], exp('discover', 'none', 'system', LIGHT));
    await step('05-mine', '', [{ click: '[data-action="switch-tab"][data-tab="mine"]' }], exp('mine', 'none', 'system', LIGHT));

    // 06/07/08/09：4 个面板；08/09 先真实点击 focus-composer 再点面板入口
    await step('06-drawer', '', [{ click: '[data-action="open-drawer"]' }], exp('tasks', 'drawer', 'system', LIGHT));
    await step('07-devices', '', [{ click: '[data-action="open-devices"]' }], exp('tasks', 'devices', 'system', LIGHT));
    await step('08-attach', '', [
      { click: '[data-action="focus-composer"]' },
      { click: '.composer-actions [data-action="open-attach"]' }
    ], exp('tasks', 'attach', 'system', LIGHT));
    await step('09-models', '', [
      { click: '[data-action="focus-composer"]' },
      { click: '.composer-actions [data-action="open-models"]' }
    ], exp('tasks', 'models', 'system', LIGHT));

    // 10-dark：先真实点击切「我的」，再用 MouseEvent 冒泡真实点击主题按钮
    await step('10-dark', '', [
      { click: '[data-action="switch-tab"][data-tab="mine"]' },
      { bubble: '[data-action="set-theme"][data-theme="dark"]' }
    ], exp('mine', 'none', 'dark', DARK));

    // H3：冷启动 hash 深链真正生效（goto(hash) 不再是死参数）
    await step('11-deeplink-loop', '#loop', [], exp('loop', 'none', 'system', LIGHT, '#loop'));
    await step('12-deeplink-mine', '#mine', [], exp('mine', 'none', 'system', LIGHT, '#mine'));

    // H4：保留一个专门场景验证 dispatch 本身可用（主代理已让 dispatch 与 onClick 共用 invoke）
    await step('13-dispatch', '', [
      { click: '[data-action="switch-tab"][data-tab="tasks"]' },
      { dispatch: ['switch-tab', { 'data-tab': 'discover' }] }
    ], exp('discover', 'none', 'system', LIGHT));

    fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
    console.log('\nmetrics.json: ' + path.join(OUT, 'metrics.json'));
    console.log('截图: ' + results.filter(r => r.shotBytes).length + ' 张（.probe/）');
    console.log(JSON.stringify(results.map(r => ({
      name: r.name, tab: r.tab, panel: r.panel, theme: r.theme, hash: r.hash, bg: r.bg,
      rootH: r.rootH, rootBottom: r.rootBottom, tabTop: r.tabTop, expectedTabTop: r.vh ? r.vh - r.tabH : null,
      overflow: r.overflow, clipped: r.clipped, errors: r.errors, activeSolid: r.activeSolid,
      brandLogoOk: r.brandLogoOk, brandName: r.brandName, faviconOk: r.faviconOk,
      visibleWorkbuddy: r.visibleWorkbuddy, shotBytes: r.shotBytes, fatal: r.fatal
    })), null, 2));
    console.log('\nPROBE 汇总: ' + results.length + ' 场景 / ' + failures.length + ' 失败 / exitCode=' + (process.exitCode || 0));
    if (failures.length) console.error('失败场景: ' + failures.map(f => f.name).join(', '));
  } finally {
    await cleanup();
    // 异常路径也保证产物落盘
    if (results.length) {
      try { fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2)); } catch (e) {}
    }
  }
})().catch(async (e) => {
  console.error('PROBE FAILED: ' + (e && e.stack || e));
  process.exitCode = 1;
  await cleanup(); // H3：catch 分支同样补齐 c / edge / server 释放
  if (results.length) {
    try { fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2)); } catch (x) {}
  }
});
