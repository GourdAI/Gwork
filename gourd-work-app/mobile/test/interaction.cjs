/* 真实点击交互回归测试：node test/interaction.cjs
 * 复用 probe.cjs 的极简静态服务器 / CDP 思路，通过 CDP Runtime.evaluate 执行真实 DOM click，
 * 验证 4 Tab / 4 面板开关 / 主题三态 / 换一换 / 触感开关 / 输入发送的状态一致性（36 项）。
 *
 * 增强：Edge 缺失明确 SKIP（不伪造通过）、端口动态探测避免并发互撞与 EADDRINUSE、
 *       c / edge / server 在 finally 与 catch 中统一释放、WebSocket 分片支持大 base64。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.probe');
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const EDGE = EDGE_CANDIDATES.find(p => fs.existsSync(p)) || EDGE_CANDIDATES[0];
// probe.cjs 动态端口池不含这两个；本脚本也避开它们，防止多进程互撞
const RESERVED_PORTS = new Set([9350, 9351]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
};
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]); }
  catch (e) { res.writeHead(400); res.end('bad request'); return; }
  if (p === '/') p = '/index.html';
  const f = path.resolve(ROOT, '.' + p);
  if (!(f === ROOT || f.startsWith(ROOT + path.sep)) ||
      !fs.existsSync(f) || !fs.statSync(f).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    // 可重试：listenWithRetry 会换端口；此处只记录，不能把「已自动恢复」误判为失败
    console.error('INTERACTION WARN: 静态端口 EADDRINUSE，交给 listenWithRetry 处理：' + e.message);
  } else {
    console.error('INTERACTION TEST FAILED: 静态服务器错误：' + e.message);
    process.exitCode = 1;
  }
});

function reservePort(exclude) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => {
        if (exclude.has(port)) reject(new Error('EADDRINUSE(soft): 保留端口 ' + port));
        else resolve(port);
      });
    });
  });
}
async function freePort(exclude) {
  for (let i = 0; i < 12; i++) {
    try { return await reservePort(exclude); }
    catch (e) { if (!/EADDRINUSE\(soft\)/.test(e.message)) throw e; }
  }
  throw new Error('无法探测到可用端口');
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
      console.error('INTERACTION WARN: 静态端口 EADDRINUSE，重试 listen(0) #' + (i + 1));
      try { server.close(); } catch (x) {}
    }
  }
  throw new Error('静态服务器连续 6 次 EADDRINUSE');
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write('GET ' + u.pathname + ' HTTP/1.1\r\nHost: ' + u.host +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' +
        crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = Buffer.alloc(0), up = false, id = 0, closed = false;
    let frag = null, fragOp = 0;
    const pending = new Map(), listeners = [];
    function frame(op, payload, maskIt) {
      const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      const mask = maskIt ? crypto.randomBytes(4) : null;
      let h;
      if (p.length < 126) h = Buffer.from([0x80 | op, (mask ? 0x80 : 0) | p.length]);
      else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = (mask ? 0x80 : 0) | 126; h.writeUInt16BE(p.length, 2); }
      else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = (mask ? 0x80 : 0) | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
      if (!mask) return Buffer.concat([h, p]);
      const m = Buffer.alloc(p.length);
      for (let i = 0; i < p.length; i++) m[i] = p[i] ^ mask[i % 4];
      return Buffer.concat([h, mask, m]);
    }
    function send(text) { sock.write(frame(0x1, Buffer.from(text, 'utf8'), true)); }
    function call(method, params) {
      return new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        send(JSON.stringify({ id: i, method, params: params || {} }));
      });
    }
    function onMessage(txt) {
      try {
        const m = JSON.parse(txt);
        if (m.id && pending.has(m.id)) {
          const p = pending.get(m.id); pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        } else if (m.method) listeners.forEach(f => f(m));
      } catch (e) {}
    }
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i === -1) return;
        up = true; buf = buf.slice(i + 4);
        resolve({ call, on: f => listeners.push(f), close: () => { if (!closed) { closed = true; try { sock.end(); } catch (e) {} } } });
      }
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let off = 2, len = b1 & 0x7f;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        let mask = null;
        if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.slice(off, off + len));
        buf = buf.slice(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (op === 0x8) { closed = true; try { sock.end(); } catch (e) {} return; }
        if (op === 0x9) { sock.write(frame(0xA, payload, true)); continue; }
        if (op === 0xA) continue;
        if (op === 0x0 || op === 0x1 || op === 0x2) {
          if (op === 0x0 && !frag) continue;
          if (op !== 0x0) fragOp = op;
          frag = frag ? Buffer.concat([frag, payload]) : payload;
          if (!fin) continue;
          const txt = frag.toString('utf8'), fop = fragOp;
          frag = null; fragOp = 0;
          if (fop === 0x1) onMessage(txt);
        }
      }
    });
    sock.on('error', (e) => { if (!up) reject(e); });
    sock.on('close', () => {
      pending.forEach(p => p.rej(new Error('CDP socket closed')));
      pending.clear();
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.error('  FAIL  ' + name + (detail ? ' | ' + JSON.stringify(detail) : '')); }
}

let c = null, edge = null, serverStarted = false;
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
    console.log('INTERACTION SKIP: 本机未安装 Edge（' + EDGE + '），真实浏览器交互测试跳过；未执行任何断言，不计为通过');
    return;
  }

  const PORT = await listenWithRetry();
  serverStarted = true;
  const exclude = new Set([...RESERVED_PORTS, PORT]);
  const profile = path.join(OUT, 'edge-interaction-' + process.pid + '-' + Date.now());

  let CDP_PORT = null, page = null;
  for (let attempt = 0; attempt < 3 && !page; attempt++) {
    CDP_PORT = await freePort(exclude);
    exclude.add(CDP_PORT);
    edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile,
      '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version'); ready = r.ok; }
      catch (e) { await sleep(150); }
      if (!ready) await sleep(100);
    }
    if (ready) {
      const tabs = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      page = tabs.find(t => t.type === 'page');
    }
    if (!page) {
      console.error('INTERACTION WARN: CDP 端口 ' + CDP_PORT + ' 未就绪，换端口重试');
      try { edge.kill(); } catch (e) {}
      edge = null;
    }
  }
  if (!page) throw new Error('CDP 未就绪（已尝试 3 个动态端口）');

  try {
    c = await cdp(page.webSocketDebuggerUrl);
    await c.call('Runtime.enable');
    await c.call('Page.enable');
    await c.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await c.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await c.call('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
    for (let i = 0; i < 60; i++) {
      const r = await c.call('Runtime.evaluate', { expression: '!!window.GWorkMobile', returnByValue: true });
      if (r.result.value) break;
      await sleep(120);
    }

    const ev = async expr => {
      const r = await c.call('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' | ' + (r.exceptionDetails.exception || {}).description);
      return r.result.value;
    };
    const click = async sel => ev(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return false; el.click(); return true; })()`);
    const state = () => ev('GWorkMobile.getState()');
    const visible = sel => ev(`!!(document.querySelector(${JSON.stringify(sel)}) && !document.querySelector(${JSON.stringify(sel)}).hidden)`);
    const reset = async () => {
      await ev('localStorage.clear()');
      await c.call('Page.reload', { ignoreCache: true });
      for (let i = 0; i < 60; i++) {
        const r = await c.call('Runtime.evaluate', { expression: '!!window.GWorkMobile', returnByValue: true });
        if (r.result.value) break;
        await sleep(120);
      }
    };

    console.log('== 初始态 ==');
    await reset();
    let s = await state();
    check('默认 tab=tasks / theme=system / panel=null', s.tab === 'tasks' && s.theme === 'system' && s.panel === null, s);
    check('默认渲染 4 个 Tab', (await ev('document.querySelectorAll(".tab-item").length')) === 4);
    check('默认 4 个建议胶囊', (await ev('document.querySelectorAll(".suggestion").length')) === 4);
    check('默认「换一换」可见', await ev('!!document.querySelector(".refresh-btn")'));
    check('无配对门禁节点', !(await ev('/连接你的|配对内核/.test(document.body.innerText)')));

    console.log('== 4 Tab 真实点击切换 ==');
    for (const id of ['loop', 'discover', 'mine', 'tasks']) {
      await click('[data-action="switch-tab"][data-tab="' + id + '"]');
      s = await state();
      check('切换至 ' + id, s.tab === id && (await ev('document.body.dataset.tab')) === id, s);
    }
    await click('[data-action="switch-tab"][data-tab="loop"]');
    check('定时任务页有青绿 FAB', await ev('!!document.querySelector(".fab")'));
    await click('[data-action="switch-tab"][data-tab="discover"]');
    check('发现页 3 组卡片', (await ev('document.querySelectorAll(".card-group").length')) === 3);
    await click('[data-action="switch-tab"][data-tab="mine"]');
    check('我的页主题分段默认「系统」', await ev('(document.querySelector(".theme-segment .is-active")||{}).textContent?.trim()') === '系统');

    console.log('== 首页两态输入 ==');
    await click('[data-action="switch-tab"][data-tab="tasks"]');
    await click('[data-action="focus-composer"]');
    s = await state();
    check('点击输入区进入聚焦态', s.composerFocused === true && (await ev('!!document.querySelector("#composer-input")')));
    check('聚焦态仍有 4 建议 + 换一换', (await ev('document.querySelectorAll(".suggestion").length')) === 4 && await ev('!!document.querySelector(".refresh-btn")'));
    const input = await ev(`(() => { const el=document.querySelector('#composer-input'); el.value='测试消息'; el.dispatchEvent(new Event('input',{bubbles:true})); return document.querySelector('.send-btn').classList.contains('is-ready'); })()`);
    check('输入后发送按钮进入 ready 态', input === true);
    await click('.send-btn');
    s = await state();
    check('发送后清空文本', s.composerText === '', s);

    console.log('== 4 个面板打开 / 关闭 ==');
    const panels = [
      ['drawer', '[data-action="open-drawer"]', '#drawer'],
      ['devices', '[data-action="open-devices"]', '#sheet'],
      ['attach', '[data-action="focus-composer"] + [data-action="open-attach"]', '#sheet'],
      ['models', '[data-action="focus-composer"] + [data-action="open-models"]', '#sheet']
    ];
    for (const [name, openSel, boxSel] of panels) {
      await reset();
      let opened;
      if (name === 'attach') { await click('[data-action="focus-composer"]'); opened = await click('.composer-actions [data-action="open-attach"]'); }
      else if (name === 'models') { await click('[data-action="focus-composer"]'); opened = await click('.composer-actions [data-action="open-models"]'); }
      else opened = await click(openSel);
      s = await state();
      check(name + ' 面板打开', opened === true && s.panel === name && await visible(boxSel), { opened, s });
      // 遮罩点击关闭
      await click('#scrim');
      s = await state();
      check(name + ' 遮罩点击可关闭', s.panel === null && !(await visible(boxSel)), s);
      // Esc 关闭：attach/models 需先回到聚焦态再点面板入口
      if (name === 'attach' || name === 'models') await click('[data-action="focus-composer"]');
      if (name === 'attach') await click('.composer-actions [data-action="open-attach"]');
      else if (name === 'models') await click('.composer-actions [data-action="open-models"]');
      else await click(openSel);
      await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      s = await state();
      check(name + ' Esc 可关闭', s.panel === null, s);
    }

    console.log('== 主题三态 / 触感开关 / 换一换 / 选择 ==');
    await reset();
    await click('[data-action="switch-tab"][data-tab="mine"]');
    for (const [t, bg] of [['light', 'rgb(250, 250, 250)'], ['dark', 'rgb(20, 20, 22)'], ['system', 'rgb(250, 250, 250)']]) {
      await click('[data-action="set-theme"][data-theme="' + t + '"]');
      s = await state();
      const actual = await ev('getComputedStyle(document.querySelector(".app-root")).backgroundColor');
      check('主题 ' + t + ' 生效', s.theme === t && actual === bg, { s, actual, bg });
    }
    const before = (await state()).haptics;
    await click('[data-action="toggle-haptics"]');
    check('触感开关可切换', (await state()).haptics === !before);
    await click('[data-action="switch-tab"][data-tab="tasks"]');
    const p0 = (await state()).suggestionPage;
    await click('[data-action="refresh-suggestions"]');
    check('换一换轮换建议组', (await state()).suggestionPage !== p0);
    await click('.suggestion');
    s = await state();
    check('点击建议填入输入并聚焦', s.composerFocused === true && s.composerText.length > 0, s);

    console.log('== 脏 localStorage 防御 ==');
    await ev(`localStorage.setItem('gwork.mobile.state.v1', JSON.stringify({tab:'bogus',theme:'neon',composerText:{x:1},suggestionPage:99,modelId:'nope'}))`);
    await c.call('Page.reload', { ignoreCache: true });
    for (let i = 0; i < 60; i++) {
      const r = await c.call('Runtime.evaluate', { expression: '!!window.GWorkMobile', returnByValue: true });
      if (r.result.value) break;
      await sleep(120);
    }
    s = await state();
    check('脏数据回退到安全默认值', s.tab === 'tasks' && s.theme === 'system' && s.composerText === '' && s.suggestionPage === 0 && s.modelId === 'hy3', s);
    check('脏数据下页面仍渲染', (await ev('document.querySelectorAll(".suggestion").length')) === 4);

    console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) process.exitCode = 1;
  } finally {
    await cleanup();
  }
})().catch(async (e) => {
  console.error('INTERACTION TEST FAILED: ' + (e && e.stack || e));
  process.exitCode = 1;
  await cleanup(); // 异常路径同样补齐 c / edge / server 释放
});
