/* 诊断：java static locale 缺失键的父路径分布
 * 目的——确定哪些父对象已存在（可直接插键）、哪些整个缺失（需创建父对象）。 */
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'ui', 'locales');
const J = path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
function flat(o, p, out) {
  out = out || {};
  for (const k of Object.keys(o || {})) {
    const v = o[k], key = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}
/* 判断 java 端某个路径是否为「已存在的对象」 */
function resolve(obj, p) {
  let cur = obj;
  for (const seg of p.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const d = read(path.join(D, 'en.json'));
const j = read(path.join(J, 'en.json'));
const A = flat(d), B = flat(j);
const missing = Object.keys(A).filter(k => !(k in B));

const parentStats = {};
for (const k of missing) {
  const parent = k.slice(0, k.lastIndexOf('.'));
  const exists = resolve(j, parent);
  const kind = exists === undefined ? '父对象缺失(需创建)'
    : (exists && typeof exists === 'object') ? '父对象存在(可直插)'
    : '父是标量(异常)';
  parentStats[parent] = parentStats[parent] || { kind, keys: [] };
  parentStats[parent].keys.push(k.slice(k.lastIndexOf('.') + 1));
}
console.log('缺失键总数(en):', missing.length);
console.log('涉及父路径数:', Object.keys(parentStats).length);
console.log('');
for (const [p, s] of Object.entries(parentStats)) {
  console.log(`[${s.kind}] ${p}  (${s.keys.length} 键)`);
  console.log('    ', s.keys.join(', '));
}

// 12 语种缺失键数是否一致
console.log('\n=== 各语种缺失键数 ===');
for (const f of fs.readdirSync(D).filter(x => x.endsWith('.json')).sort()) {
  const a = flat(read(path.join(D, f))), b = flat(read(path.join(J, f)));
  const n = Object.keys(a).filter(k => !(k in b)).length;
  const extra = Object.keys(b).filter(k => !(k in a)).length;
  console.log(`  ${f}: java缺 ${n}  java多 ${extra}`);
}
