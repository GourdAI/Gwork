/* 诊断 java static locale 的 settings.mcp 结构，判断 market 块该插在哪、以什么风格 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', '..', 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');
const f = path.join(DIR, 'en.json');
const raw = fs.readFileSync(f, 'utf8');
const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
const lines = text.split('\n');
console.log('BOM=' + (raw.charCodeAt(0) === 0xFEFF) + ' lines=' + lines.length);
console.log('CRLF=' + raw.includes('\r\n'));

// 找 "mcp" 键所在行
lines.forEach((l, i) => {
  if (/^\s*"mcp"\s*:/.test(l)) {
    console.log('\n--- "mcp" 位于行 ' + (i + 1) + ' ---');
    for (let j = i; j < Math.min(i + 26, lines.length); j++) {
      console.log((j + 1) + ': ' + JSON.stringify(lines[j]));
    }
  }
});

// 解析出 settings.mcp 的键
const j = JSON.parse(text);
console.log('\nsettings.mcp keys =', Object.keys(j.settings.mcp));
console.log('settings.mcp.market exists =', 'market' in j.settings.mcp);

// desktop 端对照
const dPath = path.join(__dirname, '..', 'ui', 'locales', 'en.json');
const dj = JSON.parse(fs.readFileSync(dPath, 'utf8').replace(/^\uFEFF/, ''));
console.log('\ndesktop settings.mcp keys =', Object.keys(dj.settings.mcp));
console.log('desktop market keys =', Object.keys(dj.settings.mcp.market));
