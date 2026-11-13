/* 恢复被 git checkout 抹掉的 java static locale market 块（12 语种）。
 *
 * 事故：codereview 期间我先用正则重写整份文件（diff 2899 行，把 PowerShell 风格的
 * 双空格分隔符与缩进全抹平），随后 `git checkout --` 恢复，连带把上一轮**未提交**
 * 的 market 块也一起抹掉了。git 无法找回未提交内容，故从 desktop 端（完好镜像）
 * 取 12 语种译文重建。
 *
 * 铁律（防再次污染整份文件）：
 *  1) 只在 `"mcp":  {` 之后插入 market 块，其余字节一律不动；
 *  2) 逐字节自检：把插入的块摘掉后必须与原文件完全一致；
 *  3) 沿用该文件自己的缩进与 `":  "` 双空格分隔符、CRLF、无 BOM；
 *  4) JSON.parse 校验 + 键序与 desktop 端一致。 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..', '..');
const DDIR = path.join(REPO, 'gourd-work', 'desktop', 'ui', 'locales');
const JDIR = path.join(REPO, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }

let done = 0;
for (const f of fs.readdirSync(DDIR).filter(x => x.endsWith('.json')).sort()) {
  const lang = f.replace('.json', '');
  const jfile = path.join(JDIR, f);
  const market = readJson(path.join(DDIR, f)).settings.mcp.market;
  const keys = Object.keys(market);
  if (keys.length !== 17) throw new Error(f + ': desktop market 键数异常 ' + keys.length);

  const raw = fs.readFileSync(jfile, 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) throw new Error(f + ': 意外带 BOM');
  const crlf = raw.includes('\r\n');
  const lines = raw.split(crlf ? '\r\n' : '\n');

  if (lines.some(l => /^\s*"market":\s*\{/.test(l))) { console.log('SKIP ' + f + '（已存在 market）'); continue; }

  // 定位 settings.mcp 的**对象**形式（另有同名叶子字符串 "mcp": "MCP"，必须排除）
  const mcpIdx = lines.findIndex(l => /^\s*"mcp":\s*\{\s*$/.test(l));
  if (mcpIdx < 0) throw new Error(f + ': 未找到 "mcp": { 对象');
  const mcpIndent = /^(\s*)/.exec(lines[mcpIdx])[1];          // 21 空格
  const childIndent = /^(\s*)/.exec(lines[mcpIdx + 1])[1];    // 33 空格（mcp 的子键）
  const delta = childIndent.length - mcpIndent.length;        // 12
  const grandIndent = ' '.repeat(childIndent.length + delta); // 45（market 的子键）
  const sep = /("[a-z_]+":)(\s*)/.exec(lines[mcpIdx + 1])[2] || ' ';  // 沿用 `":  "`

  const rows = keys.map((k, i) =>
    grandIndent + '"' + k + '":' + sep + JSON.stringify(market[k]) + (i === keys.length - 1 ? '' : ','));
  const block = [
    childIndent + '"market":' + sep + '{',
    ...rows,
    childIndent + '},',
  ];

  const outLines = lines.slice(0, mcpIdx + 1).concat(block, lines.slice(mcpIdx + 1));
  const out = outLines.join(crlf ? '\r\n' : '\n');

  // 自检 1：JSON 合法，且 market 键序与 desktop 完全一致
  const after = readJsonFromString(out);
  const gotKeys = Object.keys(after.settings.mcp.market);
  if (JSON.stringify(gotKeys) !== JSON.stringify(keys)) throw new Error(f + ': 键序不符');
  for (const k of keys) if (after.settings.mcp.market[k] !== market[k]) throw new Error(f + ': 值不符 ' + k);
  // 自检 2：除新增 market 外，settings.mcp 其余键一个没变、没丢
  const before = readJson(jfile);
  for (const k of Object.keys(before.settings.mcp)) {
    if (k === 'market') continue;
    if (before.settings.mcp[k] !== after.settings.mcp[k]) throw new Error(f + ': 既有键被改坏 ' + k);
  }
  // 自检 3：摘掉插入块后必须与原文件逐字节一致（证明没有溢出改动）
  const revert = outLines.slice(0, mcpIdx + 1).concat(lines.slice(mcpIdx + 1)).join(crlf ? '\r\n' : '\n');
  if (revert !== raw) throw new Error(f + ': 改动溢出（会污染整份文件）');

  fs.writeFileSync(jfile, out, 'utf8');
  done++;
  console.log('OK ' + f + ' 插入 ' + keys.length + ' 键，缩进 ' + childIndent.length + '/' + grandIndent.length + '，分隔符 ' + JSON.stringify(sep));
}
console.log('\n恢复文件数=' + done);

function readJsonFromString(s) { return JSON.parse(s.replace(/^\uFEFF/, '')); }
