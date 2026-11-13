/* 探测 locale 原始格式：缩进、BOM、行尾、market 块的原文样式 */
const fs = require('fs');
const path = require('path');
for (const dir of ['ui/locales', '../../gourdai-java/gourd-ai-agent/src/main/resources/static/locales']) {
  console.log('=====', dir);
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const f of files.slice(0, 3)) {
    const buf = fs.readFileSync(path.join(dir, f));
    const s = buf.toString('utf8');
    const bom = s.charCodeAt(0) === 0xFEFF;
    const crlf = s.includes('\r\n');
    const i = s.indexOf('"market"');
    console.log(`--- ${f} BOM=${bom} CRLF=${crlf} bytes=${buf.length}`);
    console.log(JSON.stringify(s.slice(i, i + 420)));
  }
}
