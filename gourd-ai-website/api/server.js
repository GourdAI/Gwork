'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY = 1024 * 1024;
const MAX_EVENTS = 10000;
const MAX_TOKEN = 1000000000;
const RETENTION_DAYS = Number(process.env.GWORK_USAGE_RETENTION_DAYS || 90);
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.GWORK_USAGE_DB || path.join(__dirname, 'data', 'usage.sqlite');
const PERIODS = { '24h': 86400000, '7d': 604800000, '30d': 2592000000, all: null };
const PUBLIC_MODEL = /^[\p{L}\p{N}_ .:@+\-]{1,256}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(value) { return crypto.createHash('sha256').update(value).digest(); }
function hex(value) { return value.toString('hex'); }
function safeEqualText(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'); const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}
function fail(res, status, message) { json(res, status, { code: status, error: message }); }
function parseBase64(value) { if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4) throw Error('invalid base64'); return Buffer.from(value, 'base64'); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY) { reject(Object.assign(Error('body too large'), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function utcHour(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(value)) throw Error('hour must be UTC hour');
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw Error('invalid hour');
  const now = Date.now(); if (date.getTime() > now + 2 * 3600000 || date.getTime() < now - RETENTION_DAYS * 86400000) throw Error('hour outside accepted range');
  return date;
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN; }
function publicModel(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 256 || /https?:\/\/|sk-[A-Za-z0-9]/i.test(raw)) {
    throw Error('model is not public');
  }
  const name = (raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw).trim();
  if (!PUBLIC_MODEL.test(name)) throw Error('model is not public');
  return name;
}
function validatePayload(body, headers) {
  const data = JSON.parse(body.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('invalid JSON');
  const deviceId = headers.device; const batchId = headers.batch;
  if (data.deviceId !== deviceId || data.batchId !== batchId) throw Error('header/body identity mismatch');
  const date = utcHour(data.hour);
  if (!Array.isArray(data.models) || !data.models.length) throw Error('models required');
  const allowed = new Set(['model', 'inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'eventIds']);
  const seen = new Set(); let events = 0; const modelsByName = new Map();
  for (const item of data.models) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !allowed.has(k))) throw Error('unknown model field');
    const model = publicModel(item.model);
    if (!Array.isArray(item.eventIds) || !item.eventIds.length) throw Error('eventIds required');
    for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']) if (!integer(item[key])) throw Error('invalid token count');
    const ids = item.eventIds.map(id => { if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) throw Error('duplicate or invalid eventId'); seen.add(id); events++; return id.toLowerCase(); });
    let target = modelsByName.get(model);
    if (!target) {
      target = { model, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, eventIds: [] };
      modelsByName.set(model, target);
    }
    for (const key of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']) {
      target[key] += item[key];
      if (!Number.isSafeInteger(target[key]) || target[key] > MAX_TOKEN) throw Error('invalid token count');
    }
    target.eventIds.push(...ids);
  }
  const models = [...modelsByName.values()];
  if (events > MAX_EVENTS) throw Error('too many events');
  const suffix = hex(sha256([...seen].sort().join(','))).slice(0, 16);
  const expected = hex(sha256(deviceId + data.hour + suffix)).slice(0, 32);
  if (expected !== batchId) throw Error('invalid batchId');
  return { data, date, models, eventCount: events };
}
function initDb(db) {
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS batches (device_id TEXT NOT NULL, batch_id TEXT NOT NULL, hour TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(device_id,batch_id)); CREATE TABLE IF NOT EXISTS usage_events (event_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, batch_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS batch_model_stats (device_id TEXT NOT NULL, batch_id TEXT NOT NULL, hour TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, calls INTEGER NOT NULL, PRIMARY KEY(device_id,batch_id,model));`);
}
function createApp({ db = new DatabaseSync(DB_PATH), token = process.env.GWORK_USAGE_CLIENT_TOKEN } = {}) {
  initDb(db);
  function submit(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!token) return fail(res, 503, 'server token is not configured');
    const h = { device: req.headers['x-gwork-device-id'], batch: req.headers['x-gwork-batch-id'], publicKey: req.headers['x-gwork-public-key'], algorithm: req.headers['x-gwork-signature-algorithm'], signature: req.headers['x-gwork-signature'] };
    if (!safeEqualText(req.headers['x-gwork-client-token'], token)) return fail(res, 401, 'unauthorized');
    if (!h.device || !h.batch || !h.publicKey || h.algorithm !== 'Ed25519' || !h.signature) return fail(res, 401, 'unauthorized');
    let body; readBody(req).then(raw => {
      let key; try { const der = parseBase64(h.publicKey); key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); if (key.asymmetricKeyType !== 'ed25519') throw Error('device'); if (hex(sha256(der)).slice(0, 32) !== h.device) throw Error('device'); if (!crypto.verify(null, raw, key, parseBase64(h.signature))) throw Error('signature'); const checked = validatePayload(raw, h); const hash = hex(sha256(raw));
        db.exec('BEGIN IMMEDIATE');
        const existing = db.prepare('SELECT payload_hash FROM batches WHERE device_id=? AND batch_id=?').get(h.device, h.batch);
        if (existing) { db.exec('ROLLBACK'); return existing.payload_hash === hash ? json(res, 200, { code: 200, data: { duplicate: true } }) : fail(res, 409, 'batch conflict'); }
        for (const m of checked.models) for (const id of m.eventIds) if (db.prepare('SELECT 1 FROM usage_events WHERE event_id=?').get(id)) { db.exec('ROLLBACK'); return fail(res, 409, 'event already submitted'); }
        db.prepare('INSERT INTO batches VALUES (?,?,?,?,?)').run(h.device, h.batch, checked.data.hour, hash, Date.now());
        const batchStats = db.prepare('INSERT INTO batch_model_stats VALUES (?,?,?,?,?,?,?,?,?)'); const eventStmt = db.prepare('INSERT INTO usage_events VALUES (?,?,?)');
        for (const m of checked.models) { batchStats.run(h.device, h.batch, checked.data.hour, m.model, m.inputTokens, m.outputTokens, m.cacheCreationTokens, m.cacheReadTokens, m.eventIds.length); for (const id of m.eventIds) eventStmt.run(id, h.device, h.batch); }
        db.exec('COMMIT'); json(res, 200, { code: 200, data: { duplicate: false } }, { 'Cache-Control': 'no-store' });
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} fail(res, e.message === 'signature' || e.message === 'device' ? 401 : 400, e.message === 'signature' || e.message === 'device' ? 'unauthorized' : 'invalid payload'); }
    }).catch(e => fail(res, e.status || 400, e.message));
  }
  function stats(url, res) {
    const period = url.searchParams.get('period') || '24h'; if (!(period in PERIODS)) return fail(res, 400, 'invalid period');
    const now = Date.now(); const start = PERIODS[period] == null ? null : now - PERIODS[period]; const previous = PERIODS[period] == null ? null : start - PERIODS[period];
    const query = (from, to) => db.prepare(`SELECT model, SUM(input_tokens+output_tokens) total, SUM(input_tokens) input, SUM(output_tokens) output, SUM(calls) calls FROM batch_model_stats WHERE (? IS NULL OR strftime('%s',hour)*1000 >= ?) AND (? IS NULL OR strftime('%s',hour)*1000 < ?) GROUP BY model`).all(from, from, to, to);
    const rows = query(start, now), old = new Map(query(previous, start).map(x => [x.model, Number(x.total)])); let total = 0, calls = 0; for (const x of rows) { total += Number(x.total); calls += Number(x.calls); }
    const models = rows.map(x => { const t = Number(x.total); const trend = period === 'all' ? null : (old.get(x.model) ? Number(((t - old.get(x.model)) / old.get(x.model) * 100).toFixed(1)) : (t ? 100 : 0)); return { model: x.model, totalTokens: t, inputTokens: Number(x.input), outputTokens: Number(x.output), calls: Number(x.calls), trendPercentage: trend }; }).sort((a,b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model)).map((x,i) => ({ rank:i+1, ...x, percentage: total ? Number((x.totalTokens/total*100).toFixed(1)) : 0 }));
    json(res, 200, { code:200, data:{ period, updatedAt:new Date().toISOString(), summary:{ totalTokens:total, calls, modelCount:models.length }, models } }, { 'Cache-Control':'public, max-age=15, stale-while-revalidate=30' });
  }
  return (req, res) => { const allowedOrigin = process.env.GWORK_CORS_ORIGIN; const origin = req.headers.origin; const headers = allowedOrigin && origin === allowedOrigin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {}; for (const [key, value] of Object.entries(headers)) res.setHeader(key, value); if (req.method === 'OPTIONS') return json(res, 204, {}, { ...headers, 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,X-GWork-Device-Id,X-GWork-Batch-Id,X-GWork-Public-Key,X-GWork-Signature-Algorithm,X-GWork-Signature,X-GWork-Client-Token' }); const url = new URL(req.url, 'http://localhost'); if (url.pathname === '/api/v1/usage/batches' && req.method === 'POST') return submit(req,res); if (url.pathname === '/api/v1/model-stats' && req.method === 'GET') return stats(url,res); fail(res,404,'not found'); };
}
function start() { if (!process.env.GWORK_USAGE_CLIENT_TOKEN) throw Error('GWORK_USAGE_CLIENT_TOKEN is required'); const server = http.createServer(createApp()); server.listen(PORT, () => console.log(`gwork api listening on ${PORT}`)); }
if (require.main === module) start();
module.exports = { createApp, sha256 };
