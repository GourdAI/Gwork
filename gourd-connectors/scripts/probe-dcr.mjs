// probe-dcr.mjs — 对 oauth 级条目实测 RFC7591 动态客户端注册是否开放。
// 只注册不授权（不产生用户数据），client_name=gwork-connector-probe。
// 用法: node probe-dcr.mjs <connectorsRoot> <out.json>
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const OUT = process.argv[3];
const TIMEOUT = 12000;
async function fetchT(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } finally { clearTimeout(timer); }
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function discoverAuthServer(mcpUrl) {
  const u = new URL(mcpUrl);
  // 1) RFC9728 protected-resource metadata → authorization_servers[0]
  let asBase = null;
  for (const c of [
    u.origin + '/.well-known/oauth-protected-resource' + (u.pathname === '/' ? '' : u.pathname),
    u.origin + '/.well-known/oauth-protected-resource',
  ]) {
    try {
      const r = await fetchT(c, { headers: { Accept: 'application/json' } });
      if (r.status === 200) {
        const j = JSON.parse(r.text);
        if (j.authorization_servers && j.authorization_servers[0]) { asBase = j.authorization_servers[0]; break; }
      }
    } catch { }
  }
  // 2) AS metadata（issuer 根或资源同源）
  const bases = asBase ? [asBase] : [u.origin];
  for (const b of bases) {
    const bu = new URL(b);
    for (const c of [
      bu.origin + '/.well-known/oauth-authorization-server' + (bu.pathname === '/' ? '' : bu.pathname),
      bu.origin + '/.well-known/oauth-authorization-server',
      bu.origin + '/.well-known/openid-configuration',
    ]) {
      try {
        const r = await fetchT(c, { headers: { Accept: 'application/json' } });
        if (r.status === 200) {
          const j = JSON.parse(r.text);
          if (j.authorization_endpoint || j.token_endpoint) return j;
        }
      } catch { }
    }
  }
  return null;
}

async function probeOne(name, url) {
  const rec = { name, url };
  try {
    const meta = await discoverAuthServer(url);
    if (!meta) { rec.verdict = 'no-as-meta'; return rec; }
    rec.issuer = meta.issuer || null;
    rec.registration_endpoint = meta.registration_endpoint || null;
    if (!meta.registration_endpoint) { rec.verdict = 'no-dcr-endpoint'; return rec; }
    const r = await fetchT(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'gwork-connector-probe',
        redirect_uris: ['http://127.0.0.1:33418/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    rec.dcrStatus = r.status;
    if (r.status === 200 || r.status === 201) {
      const j = JSON.parse(r.text);
      rec.verdict = j.client_id ? 'dcr-open' : 'dcr-no-client-id';
    } else {
      rec.verdict = 'dcr-rejected';
      rec.bodyHead = r.text.slice(0, 200);
    }
  } catch (e) { rec.verdict = 'error'; rec.error = String(e && e.message || e).slice(0, 140); }
  return rec;
}

const targets = [];
for (const dir of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const plugin = readJson(path.join(ROOT, dir.name, '.gwork-plugin', 'plugin.json'));
  const gw = plugin && plugin.extensions && plugin.extensions['cn.gourd.gwork'];
  if (!gw || gw.tier !== 'oauth') continue;
  const mcp = readJson(path.join(ROOT, dir.name, 'mcp.json'));
  const cfg = mcp && mcp.mcpServers && Object.values(mcp.mcpServers)[0];
  if (cfg && cfg.url) targets.push({ name: dir.name, url: cfg.url });
}
console.log('probing DCR for', targets.length, 'oauth connectors');
const results = [];
let idx = 0, done = 0;
async function worker() {
  while (idx < targets.length) {
    const t = targets[idx++];
    results.push(await probeOne(t.name, t.url));
    if (++done % 20 === 0) console.log(done + '/' + targets.length);
  }
}
await Promise.all(Array.from({ length: 10 }, worker));
const counts = {};
for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
fs.writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), counts, results }, null, 2));
console.log('DONE', JSON.stringify(counts));