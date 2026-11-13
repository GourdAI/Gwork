/* 批量改 24 份 locale 的 settings.mcp.market 块：
   - 删死键 try_it（P0-1 砍掉示例区）、detail（K 项：卡片按钮改 + 号，详情按钮移除）
   - 加 5 个错误文案键（P2-2 / P2-1，均带 {msg} 占位）
   必须文本级操作：desktop 端是标准 2 空格缩进，java 端是 PowerShell 风格
   （37 空格缩进 + 双空格分隔符）。JSON.parse+stringify 会毁掉 java 端既有格式。
   做法：解析出 market 块的原始行格式 → 重建该块的键值行 → 原位替换 → JSON.parse 验证。 */
const fs = require('fs');
const path = require('path');

const ADD = {
  'zh-CN': { load_failed: '魔搭 MCP 目录加载失败：{msg}', install_failed: '安装失败：{msg}', installed_names: '已安装：{msg}', detail_failed: '加载详情失败：{msg}', retry: '重试' },
  'zh-TW': { load_failed: '魔搭 MCP 目錄載入失敗：{msg}', install_failed: '安裝失敗：{msg}', installed_names: '已安裝：{msg}', detail_failed: '載入詳情失敗：{msg}', retry: '重試' },
  en: { load_failed: 'Failed to load the MCP directory: {msg}', install_failed: 'Install failed: {msg}', installed_names: 'Installed: {msg}', detail_failed: 'Failed to load details: {msg}', retry: 'Retry' },
  de: { load_failed: 'MCP-Verzeichnis konnte nicht geladen werden: {msg}', install_failed: 'Installation fehlgeschlagen: {msg}', installed_names: 'Installiert: {msg}', detail_failed: 'Details konnten nicht geladen werden: {msg}', retry: 'Erneut versuchen' },
  el: { load_failed: 'Αποτυχία φόρτωσης του καταλόγου MCP: {msg}', install_failed: 'Η εγκατάσταση απέτυχε: {msg}', installed_names: 'Εγκαταστάθηκε: {msg}', detail_failed: 'Αποτυχία φόρτωσης λεπτομερειών: {msg}', retry: 'Επανάληψη' },
  es: { load_failed: 'Error al cargar el directorio MCP: {msg}', install_failed: 'Error de instalación: {msg}', installed_names: 'Instalado: {msg}', detail_failed: 'Error al cargar los detalles: {msg}', retry: 'Reintentar' },
  fr: { load_failed: "Échec du chargement de l'annuaire MCP : {msg}", install_failed: "Échec de l'installation : {msg}", installed_names: 'Installé : {msg}', detail_failed: 'Échec du chargement des détails : {msg}', retry: 'Réessayer' },
  ja: { load_failed: 'MCP ディレクトリの読み込みに失敗しました：{msg}', install_failed: 'インストールに失敗しました：{msg}', installed_names: 'インストール済み：{msg}', detail_failed: '詳細の読み込みに失敗しました：{msg}', retry: '再試行' },
  pt: { load_failed: 'Falha ao carregar o diretório MCP: {msg}', install_failed: 'Falha na instalação: {msg}', installed_names: 'Instalado: {msg}', detail_failed: 'Falha ao carregar os detalhes: {msg}', retry: 'Tentar novamente' },
  ro: { load_failed: 'Nu s-a putut încărca directorul MCP: {msg}', install_failed: 'Instalarea a eșuat: {msg}', installed_names: 'Instalat: {msg}', detail_failed: 'Nu s-au putut încărca detaliile: {msg}', retry: 'Reîncearcă' },
  ru: { load_failed: 'Не удалось загрузить каталог MCP: {msg}', install_failed: 'Ошибка установки: {msg}', installed_names: 'Установлено: {msg}', detail_failed: 'Не удалось загрузить подробности: {msg}', retry: 'Повторить' },
  vi: { load_failed: 'Không tải được danh mục MCP: {msg}', install_failed: 'Cài đặt thất bại: {msg}', installed_names: 'Đã cài đặt: {msg}', detail_failed: 'Không tải được chi tiết: {msg}', retry: 'Thử lại' },
};
const DROP = ['try_it', 'detail'];
const NEW_ORDER = ['load_failed', 'install_failed', 'installed_names', 'detail_failed', 'retry'];

const DIRS = [
  path.join(__dirname, '..', 'ui', 'locales'),
  path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales'),
];

let changed = 0, errs = [];
for (const dir of DIRS) {
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    const lang = f.replace(/\.json$/, '');
    const add = ADD[lang];
    if (!add) { errs.push(f + ': 无该语种译文表'); continue; }
    const file = path.join(dir, f);
    let s = fs.readFileSync(file, 'utf8');
    const hadBom = s.charCodeAt(0) === 0xFEFF;
    const body = hadBom ? s.slice(1) : s;

    // 定位 "market": { ... } 块（market 下全是扁平字符串，无嵌套对象）
    const m = /"market":(\s*)\{\n([\s\S]*?)\n(\s*)\}/.exec(body);
    if (!m) { errs.push(f + ': 未找到 market 块'); continue; }
    const openGap = m[1];          // "market": 与 { 之间的空白（java 端是双空格）
    const inner = m[2];
    const closeIndent = m[3];

    // 从块内提取键值对，保留原顺序
    const pairs = [];
    const rowRe = /^(\s*)"([^"]+)":(\s*)"((?:[^"\\]|\\.)*)"(,?)\s*$/gm;
    let rm;
    while ((rm = rowRe.exec(inner)) !== null) {
      pairs.push({ indent: rm[1], key: rm[2], gap: rm[3], val: rm[4] });
    }
    if (!pairs.length) { errs.push(f + ': market 块内解析不到键'); continue; }
    const style = pairs[0];        // 沿用该文件自己的缩进与键值分隔风格

    const kept = pairs.filter(p => !DROP.includes(p.key)).map(p => p.key);
    const missing = NEW_ORDER.filter(k => !kept.includes(k));
    const finalKeys = kept.concat(missing);

    const rows = finalKeys.map((k, i) => {
      const val = (k in add) ? add[k] : (pairs.find(p => p.key === k) || {}).val;
      if (val === undefined) throw new Error(f + ': 键 ' + k + ' 无译文');
      const comma = i === finalKeys.length - 1 ? '' : ',';
      return style.indent + JSON.stringify(k) + ':' + style.gap + JSON.stringify(val) + comma;
    });
    const newBlock = '"market":' + openGap + '{\n' + rows.join('\n') + '\n' + closeIndent + '}';
    const out = body.slice(0, m.index) + newBlock + body.slice(m.index + m[0].length);

    // 验证：JSON 合法 + 键集正确 + 无死键
    const obj = JSON.parse(out);
    const mkt = obj.settings.mcp.market;
    const got = Object.keys(mkt);
    if (got.length !== finalKeys.length) throw new Error(f + ': 键数不符');
    for (const d of DROP) if (d in mkt) throw new Error(f + ': 死键未删 ' + d);
    // retry 是纯按钮文案，不带占位符；其余 4 个必须带 {msg}，否则插值失效、
    // 界面上会漏出字面 {msg}
    const WITH_MSG = NEW_ORDER.filter(k => k !== 'retry');
    for (const k of WITH_MSG) {
      if (typeof mkt[k] !== 'string' || !mkt[k].includes('{msg}')) throw new Error(f + ': 新键 ' + k + ' 缺 {msg}');
    }
    if (typeof mkt.retry !== 'string' || mkt.retry.includes('{msg}')) throw new Error(f + ': retry 应为纯文案');
    fs.writeFileSync(file, (hadBom ? '\uFEFF' : '') + out, 'utf8');
    changed++;
    console.log('OK ' + path.basename(dir) + '/' + f + ' keys=' + got.length);
  }
}
console.log('\nchanged=' + changed + ' errors=' + errs.length);
errs.forEach(e => console.log('  ! ' + e));
