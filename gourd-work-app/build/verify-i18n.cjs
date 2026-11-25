/* i18n 12 语言全量校验：key 对齐 / 占位符一致 / 品牌词 / JSON 解析 / 接线一致 */
const fs = require('fs');
const path = require('path');
const appRoot = path.resolve(__dirname, '..');
const dir = path.join(appRoot, 'locale') + path.sep;
const langs = ['zh-Hans','zh-Hant','en','de','ja','ru','el','es','fr','pt','ro','vi'];
let fail = 0;
const err = (m) => { console.log('FAIL:', m); fail++; };

const packs = {};
for (const l of langs) {
  const p = dir + l + '.json';
  if (!fs.existsSync(p)) { err(l + '.json missing'); continue; }
  try { packs[l] = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { err(l + '.json parse: ' + e.message); }
}
const base = Object.keys(packs['zh-Hans']);
console.log('base keys:', base.length, '| langs:', Object.keys(packs).length);

const ph = s => (String(s).match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
for (const l of langs) {
  const pack = packs[l]; if (!pack) continue;
  const ks = Object.keys(pack);
  // key 集合与顺序都对齐
  if (ks.length !== base.length) err(l + ' key count ' + ks.length);
  const missing = base.filter(k => !(k in pack));
  const extra = ks.filter(k => !base.includes(k));
  if (missing.length) err(l + ' missing: ' + missing.join(','));
  if (extra.length) err(l + ' extra: ' + extra.join(','));
  if (ks.join('|') !== base.join('|')) console.log('NOTE: ' + l + ' key order differs (not fatal)');
  for (const k of base) {
    if (!(k in pack)) continue;
    const v = pack[k];
    if (typeof v !== 'string' || v.length === 0) { err(l + ' ' + k + ' empty/non-string'); continue; }
    if (ph(packs['zh-Hans'][k]) !== ph(v)) err(l + ' ' + k + ' placeholder mismatch: [' + ph(packs['zh-Hans'][k]) + '] vs [' + ph(v) + ']');
    // 品牌词保真：zh-Hans 里含 GWork 的词条，译文也必须含 GWork
    if (packs['zh-Hans'][k].includes('GWork') && !v.includes('GWork')) err(l + ' ' + k + ' lost GWork brand');
    // 换行结构（chat.mockReply 的 \n\n 与编号行）
    const nl = s => (String(s).match(/\n/g) || []).length;
    if (nl(packs['zh-Hans'][k]) !== nl(v)) err(l + ' ' + k + ' newline count mismatch');
    // 上游品牌残留
    if (/veryclaw|workbuddy|uni-ai x/i.test(v)) err(l + ' ' + k + ' legacy brand: ' + v);
  }
  // 注：早期有 lang.* 词条存放语言原名，现已移除——pages/mine 的 LANG_OPTIONS 直接硬编码
  // 原名（中文 / English / Deutsch…），语言名不随当前语言翻译，走 locale 反而多一层间接。
}

// i18n.ts 接线：12 个 import + messages 注册
const i18nSrc = fs.readFileSync(dir + 'i18n.ts', 'utf8');
for (const l of langs) {
  const file = l + '.json';
  if (!i18nSrc.includes("from './" + file + "'")) err('i18n.ts missing import ' + file);
}
// useLocale.ts：Locale 联合类型与 LOCALES 数组包含全部 12 个
const ul = fs.readFileSync(path.join(appRoot, 'hooks', 'useLocale.ts'), 'utf8');
for (const l of langs) {
  if (!ul.includes("'" + l + "'")) err('useLocale.ts missing ' + l);
}
// mine 语言选项 12 项
const mine = fs.readFileSync(path.join(appRoot, 'pages', 'mine', 'index.uvue'), 'utf8');
const opts = mine.match(/\{ value: '[^']+', label: '[^']+' \}/g) || [];
const langOpts = opts.filter(o => langs.some(l => o.includes("value: '" + l + "'")));
if (langOpts.length !== 12) err('mine LANG_OPTIONS count = ' + langOpts.length);
for (const l of langs) if (!langOpts.some(o => o.includes("value: '" + l + "'"))) err('mine missing option ' + l);

// 与桌面端语言集对齐核对（zh-CN→zh-Hans, zh-TW→zh-Hant 映射）
const desktop = fs.readdirSync(path.join(appRoot, '..', 'gourd-work', 'desktop', 'ui', 'locales')).filter(f => f.endsWith('.json')).map(f => f.replace('.json',''));
const map = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };
const mapped = desktop.map(d => map[d] || d).sort();
if (mapped.join(',') !== [...langs].sort().join(',')) err('language set != desktop: ' + mapped.join(','));

console.log(fail === 0 ? 'ALL CHECKS PASSED (12 langs x ' + base.length + ' keys)' : fail + ' CHECK(S) FAILED');
process.exit(fail === 0 ? 0 : 1);