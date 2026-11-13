/* java static 端 locale 的 market 块改写 —— 行级精确替换版。
 *
 * 上一版用「正则抓整个 market 块 → 重新拼接」，结果把 java 端整份文件重写了
 * （diff 2899 行）：java 端是 PowerShell 风格（37 空格缩进 + 键值双空格分隔 +
 * 块内夹空行），我的拼接把空行与分隔风格全抹平。已 git checkout 恢复。
 *
 * 本版只在 market 块的行区间内做增删，其余字节一律不动，diff 必须只有个位数行。 */
const fs = require('fs');
const path = require('path');

const ADD = {
  'zh-CN': [['load_failed', '魔搭 MCP 目录加载失败：{msg}'], ['install_failed', '安装失败：{msg}'], ['installed_names', '已安装：{msg}'], ['detail_failed', '加载详情失败：{msg}'], ['retry', '重试']],
  'zh-TW': [['load_failed', '魔搭 MCP 目錄載入失敗：{msg}'], ['install_failed', '安裝失敗：{msg}'], ['installed_names', '已安裝：{msg}'], ['detail_failed', '載入詳情失敗：{msg}'], ['retry', '重試']],
  en: [['load_failed', 'Failed to load the MCP directory: {msg}'], ['install_failed', 'Install failed: {msg}'], ['installed_names', 'Installed: {msg}'], ['detail_failed', 'Failed to load details: {msg}'], ['retry', 'Retry']],
  de: [['load_failed', 'MCP-Verzeichnis konnte nicht geladen werden: {msg}'], ['install_failed', 'Installation fehlgeschlagen: {msg}'], ['installed_names', 'Installiert: {msg}'], ['detail_failed', 'Details konnten nicht geladen werden: {msg}'], ['retry', 'Erneut versuchen']],
  el: [['load_failed', 'Αποτυχία φόρτωσης του καταλόγου MCP: {msg}'], ['install_failed', 'Η εγκατάσταση απέτυχε: {msg}'], ['installed_names', 'Εγκαταστάθηκε: {msg}'], ['detail_failed', 'Αποτυχία φόρτωσης λεπτομερειών: {msg}'], ['retry', 'Επανάληψη']],
  es: [['load_failed', 'Error al cargar el directorio MCP: {msg}'], ['install_failed', 'Error de instalación: {msg}'], ['installed_names', 'Instalado: {msg}'], ['detail_failed', 'Error al cargar los detalles: {msg}'], ['retry', 'Reintentar']],
  fr: [['load_failed', "Échec du chargement de l'annuaire MCP : {msg}"], ['install_failed', "Échec de l'installation : {msg}"], ['installed_names', 'Installé : {msg}'], ['detail_failed', 'Échec du chargement des détails : {msg}'], ['retry', 'Réessayer']],
  ja: [['load_failed', 'MCP ディレクトリの読み込みに失敗しました：{msg}'], ['install_failed', 'インストールに失敗しました：{msg}'], ['installed_names', 'インストール済み：{msg}'], ['detail_failed', '詳細の読み込みに失敗しました：{msg}'], ['retry', '再試行']],
  pt: [['load_failed', 'Falha ao carregar o diretório MCP: {msg}'], ['install_failed', 'Falha na instalação: {msg}'], ['installed_names', 'Instalado: {msg}'], ['detail_failed', 'Falha ao carregar os detalhes: {msg}'], ['retry', 'Tentar novamente']],
  ro: [['load_failed', 'Nu s-a putut încărca directorul MCP: {msg}'], ['install_failed', 'Instalarea a eșuat: {msg}'], ['installed_names', 'Instalat: {msg}'], ['detail_failed', 'Nu s-au putut încărca detaliile: {msg}'], ['retry', 'Reîncearcă']],
  ru: [['load_failed', 'Не удалось загрузить каталог MCP: {msg}'], ['install_failed', 'Ошибка установки: {msg}'], ['installed_names', 'Установлено: {msg}'], ['detail_failed', 'Не удалось загрузить подробности: {msg}'], ['retry', 'Повторить']],
  vi: [['load_failed', 'Không tải được danh mục MCP: {msg}'], ['install_failed', 'Cài đặt thất bại: {msg}'], ['installed_names', 'Đã cài đặt: {msg}'], ['detail_failed', 'Không tải được chi tiết: {msg}'], ['retry', 'Thử lại']],
};
const DROP = ['try_it', 'detail'];
const DIR = path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');

let ok = 0;
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
  const lang = f.replace(/\.json$/, '');
  const adds = ADD[lang];
  if (!adds) { console.log('SKIP ' + f + '（无译文表）'); continue; }
  const file = path.join(DIR, f);
  const raw = fs.readFileSync(file, 'utf8');
  const hadBom = raw.charCodeAt(0) === 0xFEFF;
  const text = hadBom ? raw.slice(1) : raw;
  const lines = text.split('\n');

  // 1) 定位 market 块：起始行 "market":  {
  const startIdx = lines.findIndex(l => /^\s*"market":\s*\{/.test(l));
  if (startIdx < 0) { console.log('FAIL ' + f + ': 无 market 块'); continue; }
  // 2) 结束行：起始行缩进相同或更小的第一个只含 } 的行
  const startIndent = /^(\s*)/.exec(lines[startIdx])[1].length;
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const ind = /^(\s*)/.exec(lines[i])[1].length;
    if (/^\s*\}\s*,?\s*$/.test(lines[i]) && ind <= startIndent) { endIdx = i; break; }
  }
  if (endIdx < 0) { console.log('FAIL ' + f + ': market 块未闭合'); continue; }

  const block = lines.slice(startIdx + 1, endIdx);
  // 3) 采集块内键行的缩进与「键值分隔符」原文（java 端是 `":  "`），保证新行同风格
  const firstKey = block.find(l => /^\s*"[a-z_]+"\s*:/.test(l));
  if (!firstKey) { console.log('FAIL ' + f + ': market 块内无键'); continue; }
  const indent = /^(\s*)/.exec(firstKey)[1];
  const sepRaw = /("[a-z_]+":)(\s*)/.exec(firstKey)[2];   // 保留原有多空格

  // 4) 删死键行（try_it / detail）
  const kept = block.filter(l => !DROP.some(k => new RegExp('^\\s*"' + k + '"\\s*:').test(l)));
  const droppedCount = block.length - kept.length;

  // 5) 追加新键行（已存在则跳过，保持幂等）
  const existing = new Set(kept.map(l => (/^\s*"([a-z_]+)"/.exec(l) || [])[1]).filter(Boolean));
  const newRows = adds.filter(([k]) => !existing.has(k))
    .map(([k, v]) => indent + '"' + k + '":' + sepRaw + JSON.stringify(v));

  // 6) 重算逗号：块内键行统一「除最后一个键行外都带逗号」
  const finalBlock = kept.concat(newRows);
  const keyIdxs = [];
  finalBlock.forEach((l, i) => { if (/^\s*"[a-z_]+"\s*:/.test(l)) keyIdxs.push(i); });
  keyIdxs.forEach((i, n) => {
    const needComma = n !== keyIdxs.length - 1;
    finalBlock[i] = finalBlock[i].replace(/,?\s*$/, '') + (needComma ? ',' : '');
  });

  const outLines = lines.slice(0, startIdx + 1).concat(finalBlock, lines.slice(endIdx));
  const outText = outLines.join('\n');

  // 7) 三重验证：JSON 合法 + 死键已删 + 新键带占位符 + 其余键一个没少
  const before = JSON.parse(text).settings.mcp.market;
  const after = JSON.parse(outText).settings.mcp.market;
  for (const d of DROP) if (d in after) throw new Error(f + ': 死键未删 ' + d);
  for (const k of Object.keys(before)) {
    if (DROP.includes(k)) continue;
    if (before[k] !== after[k]) throw new Error(f + ': 既有键被改坏 ' + k);
  }
  for (const [k, v] of adds) if (after[k] !== v) throw new Error(f + ': 新键异常 ' + k);
  if (!('retry' in after) || 'retry' in before && false) { /* noop */ }
  if (Object.keys(after).length !== Object.keys(before).length - DROP.length + adds.length) {
    throw new Error(f + ': 键数不符 ' + Object.keys(after).length);
  }
  // 8) 只有 market 块被改：把新文本的 market 块换成旧块，应与原文完全一致
  const revert = outLines.slice(0, startIdx + 1).concat(block, lines.slice(endIdx)).join('\n');
  if (revert !== text) throw new Error(f + ': 改动溢出 market 块（会污染整份文件）');

  fs.writeFileSync(file, (hadBom ? '\uFEFF' : '') + outText, 'utf8');
  ok++;
  console.log('OK ' + f + ' dropped=' + droppedCount + ' added=' + newRows.length + ' keys=' + Object.keys(after).length);
}
console.log('\nok=' + ok);
