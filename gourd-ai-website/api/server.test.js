'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('./server');

const TOKEN = 'test-client-token-which-is-not-empty';
function sha(value) { return crypto.createHash('sha256').update(value).digest(); }
function hex(value) { return value.toString('hex'); }
function request(server, method, pathname, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const req = http.request({ hostname:'127.0.0.1', port:address.port, method, path:pathname, headers:{...headers, ...(body ? {'Content-Length':Buffer.byteLength(body)} : {})} }, res => { let text=''; res.setEncoding('utf8'); res.on('data', x => text += x); res.on('end', () => resolve({ status:res.statusCode, body:text ? JSON.parse(text) : null })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
function signedBatch(pair, eventIds, overrides = {}) {
  const pub = pair.publicKey.export({format:'der', type:'spki'});
  const device = hex(sha(pub)).slice(0,32);
  const hour = overrides.hour || new Date(Math.floor(Date.now()/3600000)*3600000).toISOString();
  const suffix = hex(sha([...eventIds].sort().join(','))).slice(0,16);
  const batch = hex(sha(device + hour + suffix)).slice(0,32);
  const data = { deviceId:device, batchId:batch, hour, models:[{model:'gpt-4o',inputTokens:10,outputTokens:5,cacheCreationTokens:0,cacheReadTokens:0,eventIds}] };
  Object.assign(data, overrides.body || {}); const body = JSON.stringify(data);
  return { body, headers:{'x-gwork-client-token':TOKEN,'x-gwork-device-id':overrides.device || device,'x-gwork-batch-id':overrides.batch || batch,'x-gwork-public-key':pub.toString('base64'),'x-gwork-signature-algorithm':'Ed25519','x-gwork-signature':crypto.sign(null, Buffer.from(body), pair.privateKey).toString('base64')}, device, batch };
}
async function withServer(fn) {
  const db = new DatabaseSync(':memory:'); const server = http.createServer(createApp({db, token:TOKEN})); await new Promise(r => server.listen(0,r)); try { await fn(server); } finally { await new Promise(r => server.close(r)); db.close(); }
}

test('accepts a valid Ed25519 batch and exposes only public stats', async () => withServer(async server => {
  const pair = crypto.generateKeyPairSync('ed25519'); const batch = signedBatch(pair, ['123e4567-e89b-12d3-a456-426614174000']);
  const accepted = await request(server, 'POST', '/api/v1/usage/batches', batch.headers, batch.body); assert.equal(accepted.status, 200);
  const result = await request(server, 'GET', '/api/v1/model-stats?period=all'); assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.body.data.models[0]).sort(), ['calls','inputTokens','model','outputTokens','percentage','rank','totalTokens','trendPercentage']); assert.equal(JSON.stringify(result.body).includes('deviceId'), false); assert.equal(JSON.stringify(result.body).includes('provider'), false);
}));

test('same batch is idempotent and different body conflicts', async () => withServer(async server => {
  const pair = crypto.generateKeyPairSync('ed25519'); const batch = signedBatch(pair, ['123e4567-e89b-12d3-a456-426614174001']);
  assert.equal((await request(server,'POST','/api/v1/usage/batches',batch.headers,batch.body)).status,200);
  assert.equal((await request(server,'POST','/api/v1/usage/batches',batch.headers,batch.body)).body.data.duplicate,true);
  const changed = signedBatch(pair, ['123e4567-e89b-12d3-a456-426614174001'], { body:{models:[{model:'gpt-4o',inputTokens:99,outputTokens:5,cacheCreationTokens:0,cacheReadTokens:0,eventIds:['123e4567-e89b-12d3-a456-426614174001']}]}}); changed.headers['x-gwork-batch-id'] = batch.batch; assert.equal((await request(server,'POST','/api/v1/usage/batches',changed.headers,changed.body)).status,409);
}));

test('merges duplicate public model names inside one batch', async () => withServer(async server => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const firstId = '123e4567-e89b-12d3-a456-426614174003';
  const secondId = '123e4567-e89b-12d3-a456-426614174004';
  const batch = signedBatch(pair, [firstId, secondId], { body: { models: [
    { model:'vendor-a/gpt-4o', inputTokens:10, outputTokens:5, cacheCreationTokens:0, cacheReadTokens:0, eventIds:[firstId] },
    { model:'vendor-b/gpt-4o', inputTokens:20, outputTokens:7, cacheCreationTokens:0, cacheReadTokens:0, eventIds:[secondId] }
  ] } });
  assert.equal((await request(server, 'POST', '/api/v1/usage/batches', batch.headers, batch.body)).status, 200);
  const stats = await request(server, 'GET', '/api/v1/model-stats?period=all');
  assert.equal(stats.body.data.models.length, 1);
  assert.equal(stats.body.data.models[0].model, 'gpt-4o');
  assert.equal(stats.body.data.models[0].inputTokens, 30);
  assert.equal(stats.body.data.models[0].outputTokens, 12);
  assert.equal(stats.body.data.models[0].calls, 2);
}));

test('rejects cross-batch event reuse, bad signature, and bad token', async () => withServer(async server => {
  const pair = crypto.generateKeyPairSync('ed25519'); const id='123e4567-e89b-12d3-a456-426614174002'; const first=signedBatch(pair,[id]); assert.equal((await request(server,'POST','/api/v1/usage/batches',first.headers,first.body)).status,200);
  const second=signedBatch(pair,[id], { hour:new Date(Math.floor(Date.now()/3600000)*3600000-3600000).toISOString() }); assert.equal((await request(server,'POST','/api/v1/usage/batches',second.headers,second.body)).status,409);
  const bad={...first.headers,'x-gwork-signature':Buffer.alloc(64).toString('base64')}; assert.equal((await request(server,'POST','/api/v1/usage/batches',bad,first.body)).status,401);
  assert.equal((await request(server,'POST','/api/v1/usage/batches',{...first.headers,'x-gwork-client-token':'wrong'},first.body)).status,401);
}));
