/* 精确列出被 git checkout 抹掉的 30 个键（含完整路径与 desktop 端值），
 * 并逐一确认 java 端父对象是否存在、是否需要创建父层。
 * 只报告，不写盘。 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..', '..');
const DREL = 'gourd-work/desktop/ui/locales/';
const JREL = 'gourdai-java/gourd-ai-agent/src/main/resources/static/locales/';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const show = (rev, p) => JSON.parse(execSync(`git show ${rev}:${p}`, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/^\uFEFF/, ''));
function flat(o, p, out) {
  out = out || {};
  for (const k of Object.keys(o || {})) {
    const v = o[k], key = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}
function resolve(obj, p) {
  if (!p) return obj;
  let cur = obj;
  for (const seg of p.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

const langs = fs.readdirSync(path.join(REPO, DREL.replace(/\//g, path.sep)))
  .filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();

// 用 en 求差集（12 语种结构一致，已验证缺失数都是 74）
const dHead = flat(show('HEAD', DREL + 'en.json'));
const jHead = flat(show('HEAD', JREL + 'en.json'));
const dNow = flat(read(path.join(REPO, DREL.replace(/\//g, path.sep), 'en.json')));
const jNow = flat(read(path.join(REPO, JREL.replace(/\//g, path.sep), 'en.json')));
const missHead = new Set(Object.keys(dHead).filter(k => !(k in jHead)));
const missNow = Object.keys(dNow).filter(k => !(k in jNow));
const wiped = missNow.filter(k => !missHead.has(k));

console.log('被抹掉的键数(en):', wiped.length);
const jObj = read(path.join(REPO, JREL.replace(/\//g, path.sep), 'en.json'));
wiped.forEach(k => {
  const parent = k.slice(0, k.lastIndexOf('.')) || '';
  const p = resolve(jObj, parent);
  const st = p === undefined ? '父缺失' : (typeof p === 'object' ? '父存在' : '父是标量!');
  console.log(`  ${st.padEnd(6)} ${k}  = ${JSON.stringify(dNow[k]).slice(0, 60)}`);
});

// 各语种这 30 个键是否都存在（值来自 desktop 端，可直接搬）
console.log('\n=== 12 语种可搬运性校验 ===');
for (const l of langs) {
  const d = flat(read(path.join(REPO, DREL.replace(/\//g, path.sep), l + '.json')));
  const miss = wiped.filter(k => !(k in d) || typeof d[k] !== 'string');
  console.log(`  ${l}: 缺失或类型异常 ${miss.length}` + (miss.length ? ' → ' + miss.join(',') : ''));
}
