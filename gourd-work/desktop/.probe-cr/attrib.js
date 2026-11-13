/* 精确归因：HEAD 态 java 缺失键集合 vs 当前态 java 缺失键集合
 * 差集 = 我在 codereview 期间因 git checkout 抹掉的键（唯一实际损伤）
 * 交集 = 历史性双端不一致（HEAD 时就缺，不归本轮） */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const REPO = path.join(__dirname, '..', '..', '..');

const D = path.join(__dirname, '..', 'ui', 'locales', 'en.json');
const JP = 'gourdai-java/gourd-ai-agent/src/main/resources/static/locales/en.json';

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
const show = (rev, p) => JSON.parse(execSync(`git show ${rev}:${p}`, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/^\uFEFF/, ''));

// 当前态
const dNow = flat(read(D));
const jNow = flat(read(path.join(REPO, JP.replace(/\//g, path.sep))));
const missNow = new Set(Object.keys(dNow).filter(k => !(k in jNow)));

// HEAD 态
const dHead = flat(show('HEAD', 'gourd-work/desktop/ui/locales/en.json'));
const jHead = flat(show('HEAD', JP));
const missHead = new Set(Object.keys(dHead).filter(k => !(k in jHead)));

console.log('HEAD 态缺失键数:', missHead.size);
console.log('当前态缺失键数:', missNow.size);

const newlyMissing = [...missNow].filter(k => !missHead.has(k));
const stillMissing = [...missNow].filter(k => missHead.has(k));
const recovered = [...missHead].filter(k => !missNow.has(k));

console.log('\n=== ⚠ 新增缺失（HEAD 时 java 有、现在没有 = 我 checkout 抹掉的）:', newlyMissing.length);
const byParent = {};
for (const k of newlyMissing) {
  const p = k.slice(0, k.lastIndexOf('.')) || '(top)';
  (byParent[p] = byParent[p] || []).push(k.slice(k.lastIndexOf('.') + 1));
}
for (const [p, ks] of Object.entries(byParent)) console.log('   ' + p + ' (' + ks.length + '): ' + ks.join(', '));

console.log('\n=== 历史性缺失（HEAD 时就缺，不归本轮）:', stillMissing.length);
const bp2 = {};
for (const k of stillMissing) {
  const p = k.slice(0, k.lastIndexOf('.')) || '(top)';
  bp2[p] = (bp2[p] || 0) + 1;
}
for (const [p, n] of Object.entries(bp2)) console.log('   ' + p + ': ' + n);

console.log('\n=== HEAD 缺但现已补上:', recovered.length);
