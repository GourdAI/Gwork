// api.js — HTTP/WS client for the GWork kernel.
// The kernel runs in-process; the base URL is injected by Tauri (window.__KERNEL_PORT__)
// or defaults to the current origin (when served via `gwork --serve --static`).

const API = (() => {
  let BASE = '';
  let WS_BASE = '';
  let ws = null;
  let wsHandlers = [];
  let reconnectTimer = null;
  let currentSessionId = '';

  async function init() {
    // Try Tauri-injected port first
    let port = window.__KERNEL_PORT__;
    if (!port && window.__TAURI_INTERNALS__) {
      try {
        port = await window.__TAURI_INTERNALS__.invoke('get_kernel_port');
      } catch (e) { /* not in tauri */ }
    }
    if (port) {
      BASE = `http://127.0.0.1:${port}`;
      WS_BASE = `ws://127.0.0.1:${port}`;
    } else {
      // Same-origin (served by kernel's static file server)
      BASE = `${location.protocol}//${location.host}`;
      WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    }
  }

  async function request(method, path, body, isForm) {
    const opts = { method };
    let url = BASE + path;
    if (method === 'GET' && body) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
        else if (v !== undefined && v !== null) qs.append(k, v);
      }
      const s = qs.toString();
      if (s) url += '?' + s;
    } else if (body) {
      if (isForm || body instanceof FormData) {
        opts.body = body;
      } else {
        opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
          if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
          else if (v !== undefined && v !== null) qs.append(k, v);
        }
        opts.body = qs.toString();
      }
    }
    try {
      const resp = await fetch(url, opts);
      return await resp.json();
    } catch (e) {
      return { code: 0, description: String(e) };
    }
  }

  const get = (path, params) => request('GET', path, params);
  const post = (path, params) => request('POST', path, params);
  const postForm = (path, formData) => request('POST', path, formData, true);

  // ── WebSocket ──
  function connectWs(sessionId) {
    currentSessionId = sessionId || '';
    if (ws) { try { ws.close(); } catch (e) {} }
    const qs = currentSessionId ? `?sessionId=${encodeURIComponent(currentSessionId)}` : '';
    ws = new WebSocket(`${WS_BASE}/web/gate${qs}`);
    ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(ev.data);
        wsHandlers.forEach(h => h(frame));
      } catch (e) {}
    };
    ws.onclose = () => {
      setConn(false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connectWs(currentSessionId), 2000);
    };
    ws.onopen = () => setConn(true);
    ws.onerror = () => {};
  }

  function onFrame(handler) { wsHandlers.push(handler); }
  function setConn(online) {
    const el = document.getElementById('connStatus');
    if (el) { el.classList.toggle('offline', !online); el.title = online ? '已连接' : '未连接'; }
  }

  return { init, get, post, postForm, connectWs, onFrame, getBase: () => BASE };
})();
