// codereview fix: 新增 cli_qr_invalid 键 12 语言 + 修 zh-TW connect_title 占位符/英文残留
// 幂等：重复运行结果一致；同时写 desktop 与 Java 壳两套 locales。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DIRS = [
  path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'locales'),
  path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales'),
];

const QR_INVALID = {
  de: 'Ungültiger QR-Code. Bitte erneut versuchen.',
  el: 'Μη έγκυρος κωδικός QR. Δοκιμάστε ξανά.',
  en: 'Invalid QR code. Please retry.',
  es: 'Código QR no válido. Inténtalo de nuevo.',
  fr: 'Code QR invalide. Veuillez réessayer.',
  ja: 'QRコードが無効です。再試行してください。',
  pt: 'Código QR inválido. Tente novamente.',
  ro: 'Cod QR invalid. Încearcă din nou.',
  ru: 'Недействительный QR-код. Повторите попытку.',
  vi: 'Mã QR không hợp lệ. Vui lòng thử lại.',
  'zh-CN': '二维码无效，请重试',
  'zh-TW': 'QR 碼無效，請重試',
};

// zh-TW 历史英文残留（仅本轮 review 点名的键），其余语言保留现状不动。
const ZH_TW = {
  'auth_connect_title': '連線並授權',
  'auth_waiting': '正在等待瀏覽器授權…',
  'auth_qr_title': '掃碼授權',
  'auth_device_title': '裝置碼授權',
  'auth_failed': '授權失敗',
  'auth_timeout': '授權逾時，請重試',
  'common_close': '關閉',
};

for (const dir of DIRS) {
  for (const [lang, text] of Object.entries(QR_INVALID)) {
    const file = path.join(dir, lang + '.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const mcp = j.settings.mcp;
    const market = mcp.market;
    market.cli_qr_invalid = text;
    if (lang === 'zh-TW') {
      market.connect_title = '連接';           // 去掉 {msg} 占位符（调用处不传 params）
      for (const [k, v] of Object.entries(ZH_TW)) {
        if (k in mcp) mcp[k] = v;
      }
    }
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  }
}
console.log('cli_qr_invalid added to 12 locales x 2 shells; zh-TW connect_title + 7 keys fixed');
