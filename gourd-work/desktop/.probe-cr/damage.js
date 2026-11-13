/* 损伤评估：java static locale 被我 git checkout 到 HEAD 后，
 * 与 desktop 端 locale 的键集差异（desktop 端完好，可作参照）。
 * 只报告，不写盘。 */
const fs = require('fs');
const path = require('path');
const D = path.join(__dirname, '..', 'ui', 'locales');
const J = path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');

function flat(o, p, out) {
  out = out || {};
  for (const k of Object.keys(o || {})) {
    const v = o[k];
    const key = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

const langs = fs.readdirSync(D).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
let totalOnlyJava = 0, totalOnlyDesktop = 0;
for (const l of langs) {
  const dp = path.join(D, l + '.json'), jp = path.join(J, l + '.json');
  if (!fs.existsSync(jp)) { console.log(l + ': java 端缺文件'); continue; }
  const a = flat(read(dp)), b = flat(read(jp));
  const onlyDesktop = Object.keys(a).filter(k => !(k in b));
  const onlyJava = Object.keys(b).filter(k => !(k in a));
  totalOnlyDesktop += onlyDesktop.length;
  totalOnlyJava += onlyJava.length;
  if (onlyDesktop.length || onlyJava.length) {
    console.log('\n=== ' + l + ' ===');
    if (onlyDesktop.length) console.log('  仅 desktop 有（java 缺，可能被我 checkout 掉）: ' + onlyDesktop.length);
    if (onlyJava.length) console.log('  仅 java 有: ' + onlyJava.length);
    // 只打印非 market 的差异，market 是已知缺失
    const nd = onlyDesktop.filter(k => !k.startsWith('settings.mcp.market.'));
    if (nd.length) console.log('  ⚠ 非 market 差异（重点核查）: ' + nd.join(', '));
  }
}
console.log('\n合计: 仅desktop=' + totalOnlyDesktop + ' 仅java=' + totalOnlyJava);
