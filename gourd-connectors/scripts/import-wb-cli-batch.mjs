#!/usr/bin/env node
// import-wb-cli-batch.mjs — 从 .import-src/connectors/ 批量落地 24 条 CLI 连接器。
// 2026-11 用户拍板：CLI 连接器扩到 28 条，全部内置随发版，彻底不连自家后台。
// 数据纪律（每条都可在脚本里复核，禁止手工编造）：
//   * package/version/bin/license 全部来自 `npm view <pkg> version bin license --json`
//     （npmmirror 实测，锁定具体版本，不用 latest / WB minVersion）；
//   * binPath 用 npm bin 映射里与 binName 对应的值；bin 是字符串则直接用；
//   * auth/status/unauth argv 来自 WB cli.json 的 win32 命令去首 token；
//     statusMatch/statusMatchJson/authUrlDomain/authWaitForExit 原样映射；
//   * 技能目录原样复制（仅 debrand：ai.workbuddy.* → ai.gwork.*，品牌整词
//     WorkBuddy → GWork；命令语法里的 --workbuddy 渠道标志按纪律剔除）；
//   * 缺 LICENSE 的技能目录补 npm license 字段文本（查不到写兜底文案）；
//   * 渠道参数（--source workbuddy / callerUmt / WB env 里的渠道身份）一律不带。
// 可重跑：每次从 .import-src 真源重建，输出字节稳定；不改现有 4 条 CLI。
// 用法：node scripts/import-wb-cli-batch.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.import-src', 'connectors');
const OUT = path.join(ROOT, 'connectors');
const REG = 'https://registry.npmmirror.com';
const DRY = process.argv.includes('--dry-run');
const FALLBACK_LICENSE = 'UNLICENSED — skills documentation from vendor public CLI package; see package repository';

// 事实来源：.import-src/connectors/<id>/ai.workbuddy/cli.json 的 init.win32。
// 24 条 npm 包（均经 npm view 实测存在）；<id> 同时是最终目录名。
const IDS = [
  '77hub-qiqi', 'awesun', 'baijimu-enterprise-ai', 'beisen-cli', 'cloudhub', 'cnb-api',
  'designkit-buddy-cli', 'gaia-ai-workforce', 'gaoding', 'guansd', 'lemonclaw', 'meitu-ai',
  'meitu-kaipai', 'miaoda', 'noxinfluencer-cli', 'oiioii', 'tencentads', 'tuniu-travel',
  'vibeknow-cli', 'yunke-cli', 'zsxq', 'ai-hive', 'cloudbase', 'edgeone-pages',
];

// categories：源 plugin.json 无 categories 字段。沿用 import-from-wb.mjs 已编排的分类
// （4 条有映射），其余按内核 market::categories() 白名单做产品域归类；不编造功能描述。
const CATEGORIES = {
  '77hub-qiqi': 'finance', 'awesun': 'os-automation', 'baijimu-enterprise-ai': 'developer-tools',
  'beisen-cli': 'communication', 'cloudhub': 'communication', 'cnb-api': 'version-control',
  'designkit-buddy-cli': 'image-and-video-processing', 'gaia-ai-workforce': 'communication',
  'gaoding': 'image-and-video-processing', 'guansd': 'developer-tools', 'lemonclaw': 'finance',
  'meitu-ai': 'image-and-video-processing', 'meitu-kaipai': 'image-and-video-processing',
  'miaoda': 'developer-tools', 'noxinfluencer-cli': 'research-and-data',
  'oiioii': 'image-and-video-processing', 'tencentads': 'research-and-data',
  'tuniu-travel': 'other', 'vibeknow-cli': 'image-and-video-processing',
  'yunke-cli': 'communication', 'zsxq': 'knowledge-and-memory',
  'ai-hive': 'image-and-video-processing', 'cloudbase': 'cloud-platforms',
  'edgeone-pages': 'cloud-platforms',
};

// 特殊形态（有据可查，均来自 cli.json 实物）：
//   ai-hive：无 init，auth/status/unAuth 均为 `npx -y <pkg>@latest <verb>`，
//     首个可执行 token 是 npx；GWork 用 node <binPath> 直跑，binName 取 npm bin
//     映射唯一键 ai-hive-mcp，argv 取 npx 命令最后一个 token（auth/status/logout）。
//   gaoding：status.win32 是 `node -e eval(Buffer.from(base64))` 包装器，解码后
//     实际执行 `gd-cli auth status --json` 并**由包装器打印** GD_AUTHENTICATED；
//     GWork 直跑 gd-cli 拿到的是 {"logged_in":true,"credential":{"valid":true}} JSON，
//     照搬 WB 的 ^GD_AUTHENTICATED$ 正则会永不匹配（授权成功仍判未授权，P0）。
//     故 argv 按解码结果落，匹配器改 matchJson（键支持点路径查嵌套字段）。
//   oiioii：WB auth 带 `--workbuddy` 渠道标志 → 按纪律剔除。
//   gaoding env.GD_CLI_INSTALL_OWNER=workbuddy、meitu-ai env.MEITU_IAM_CLIENT_TYPE=
//     workbuddy 属 WB 渠道身份，均不落 cli_spec.npmEnv；meitu-ai 其余纯功能 env
//     保留（与 WB 声明一致，非渠道参数）。
//   cloudbase/edgeone-pages：WB cli.json 无 statusMatch/statusMatchJson。按 WB
//     原命令输出语义落通用匹配正则（env list 表格非空 / whoami 输出含用户信息），
//     并在交付报告标注「无 WB 匹配器，按原状态命令输出语义落通用正则」。
const STATUS_FALLBACK_REGEX = {
  cloudbase: '(?:envId|EnvId|环境\\s*ID|┌|\\|)', // tcb env list：表头/行即已登录
  'edgeone-pages': '(?:User|user|Account|account|Email|email|Login|login|@)', // edgeone whoami
};
const AUTH_ARGV_OVERRIDES = {
  'ai-hive': ['auth'], 'gaoding': ['auth', 'login', '--no-browser'],
};
const STATUS_ARGV_OVERRIDES = {
  'ai-hive': ['status'], 'gaoding': ['auth', 'status', '--json'],
};
// 直跑 CLI（不经过 WB 的 node -e 包装器）时输出形态不同：包装器打印的标记串
// 是包装器自己写的，不是 CLI 输出。这里按 CLI 原生 JSON 输出声明匹配器。
const STATUS_MATCH_OVERRIDES = {
  gaoding: { matchJson: { 'logged_in': 'true', 'credential.valid': 'true' } },
};
const UNAUTH_ARGV_OVERRIDES = { 'ai-hive': ['logout'] };
const AUTH_DROP_ARGS = new Set(['--workbuddy']); // oiioii：WB 渠道标志
const QR_PNG_ARGS = new Set(['--output-qrcode']); // 本批无 --output-qrcode；awesun 的 --qrcode 为布尔交互标志，不是 PNG 参数
// 设备码形态：WB cli.json 带 authDeviceFlow.uriPattern，内核 CliSpec 无对应字段，
// 本轮仍按 auth.argv+urlDomain 落地，报告标注可能需要内核扩展支持。
const DEV_FLOW_IDS = new Set(['cnb-api', 'noxinfluencer-cli', 'vibeknow-cli']);
// WB 客户端专用交互标志（不是 CLI 业务参数，GWork 内核没有对应二维码/URL 弹窗
// 协议）：从 auth argv 剔除，让 CLI 走自身默认授权流程。
const WB_UI_FLAGS = { awesun: new Set(['--qrcode', '--url']) };

function tokens(cmd) {
  const out = [];
  let cur = '', quote = null;
  for (const ch of cmd) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function pkgFromInit(t) {
  const rest = t.filter((x) => !/^(npm|npm\.cmd|npx|npx\.cmd|install|i|-g|--global|--force|-y|--yes)$/.test(x)
    && !x.startsWith('--allow-scripts='));
  const p = rest.find((x) => x.startsWith('@') || /^[a-zA-Z0-9]/.test(x));
  if (!p) return null;
  const at = p.lastIndexOf('@');
  return at > 0 ? p.slice(0, at) : p;
}
function pkgFromNpx(t) {
  return t.find((x) => /^@?[a-zA-Z0-9][^@]*@latest$/.test(x))?.replace(/@latest$/, '') || null;
}
function npmMetadata(pkg) {
  // 一次 npm view 拿 version/bin/license；全部为实测值，失败即跳过该条（不瞎填）。
  const out = execSync('npm view "' + pkg + '" version bin license --json --registry=' + REG,
    { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
  const j = JSON.parse(out);
  const m = Array.isArray(j) ? j[j.length - 1] : j;
  if (!m || typeof m.version !== 'string' || !m.version) throw new Error('npm view 缺 version');
  if (!m.bin) throw new Error('npm view 缺 bin');
  return m;
}
function stripBinToken(t) { return t[0].replace(/\.(cmd|exe)$/i, ''); }
function resolveBinPath(meta, binName) {
  if (typeof meta.bin === 'string') return meta.bin;
  if (meta.bin && typeof meta.bin[binName] === 'string') return meta.bin[binName];
  throw new Error('npm bin 映射缺 ' + binName + '（bin=' + JSON.stringify(meta.bin) + '）');
}
function tailArgv(t, overrides, key) {
  if (overrides[key]) return overrides[key].slice();
  const rest = t.slice(1).filter((a) => !AUTH_DROP_ARGS.has(a));
  if (!rest.length) throw new Error(key + ' argv 为空');
  return rest;
}
function debrandDisplay(text) { return String(text || '').replace(/WorkBuddy/gi, 'GWork'); }
function debrandSkillText(text) {
  return String(text)
    // 品牌整词 → GWork；技能目录名/frontmatter 里的连字符小写形态也一并清洗
    // （lemonclaw-workbuddy → lemonclaw-gwork；属展示文案，不是命令语法）。
    .replace(/ai\.workbuddy\./g, 'ai.gwork.')
    .replace(/WorkBuddy/g, 'GWork')
    .replace(/([a-z0-9])-workbuddy\b/g, '$1-gwork');
}
// 技能目录名含品牌词时重命名（源目录 → 落地目录），清单/frontmatter 同步。
function debrandDirName(name) { return name.replace(/([a-z0-9])-workbuddy\b/g, '$1-gwork'); }
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.py', '.js', '.jsx', '.ts', '.css', '.html', '.xml', '.svg', '.yml', '.yaml', '.csv', '.sh']);
function isTextFile(p) {
  const b = path.basename(p);
  if (b === 'LICENSE' || b === 'NOTICE' || /^LICENSE\./i.test(b)) return false; // 法律文本不动
  return TEXT_EXT.has(path.extname(p).toLowerCase());
}
function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error('技能源含符号链接: ' + p);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
function licenseText(license, pkg) {
  // 用户拍板：LICENSE 内容为 npm view <pkg> license 实测字段本身；查不到写兜底文案。
  // 不伪造许可全文、不写来源声明模板（那是并行旧版，已废弃）。
  if (!license || /^\s*$/.test(license)) return FALLBACK_LICENSE + '\n';
  return String(license).trim() + '\n';
}
function readme(id, pkg, version, nameZh, skillCount) {
  return '## ' + nameZh + ' CLI 连接器\n\n厂商官方 `' + pkg + '@' + version + '`，扫码/浏览器授权，内置 '
    + skillCount + ' 套官方技能。\n\n### 连接方式\n\n1. 点击「连接」，GWork 自动准备 Node 运行时并安装官方 CLI；\n'
    + '2. 弹窗展示授权链接/二维码，按厂商页面完成扫码或浏览器确认；\n'
    + '3. 授权完成后自动连接。凭据由官方 CLI 自管，GWork 不接触 token。\n\n'
    + '技能包来源：厂商公开 CLI 包随附技能文档（公开仓库缓存副本）；许可见各技能目录 LICENSE。';
}

const report = { generated: [], skipped: [], fallbackLicenseIds: [], deviceFlowIds: [], noStatusMatcherIds: [] };
for (const id of IDS) {
  const base = path.join(SRC, id);
  const cli = JSON.parse(fs.readFileSync(path.join(base, 'ai.workbuddy', 'cli.json'), 'utf8'));
  const pj = JSON.parse(fs.readFileSync(path.join(base, '.codebuddy-plugin', 'plugin.json'), 'utf8'));
  const d = pj.extensions['ai.workbuddy'].display || {};
  const initT = cli.init?.win32 ? tokens(cli.init.win32) : [];
  const authT = tokens(cli.auth.win32);
  const statusT = tokens(cli.status.win32);
  const unauthT = tokens(cli.unAuth.win32);
  const vcT = cli.versionCheck?.command?.win32 ? tokens(cli.versionCheck.command.win32) : [];
  let pkg = cli.init?.win32 ? pkgFromInit(initT) : null;
  if (!pkg) pkg = pkgFromNpx(authT); // ai-hive
  let meta;
  try { meta = npmMetadata(pkg); }
  catch (e) { report.skipped.push({ id, reason: 'npm view ' + pkg + ' 失败: ' + e.message }); console.error('SKIP ' + id + ': ' + e.message); continue; }
  let binName = stripBinToken(vcT.length ? vcT : authT);
  if (id === 'ai-hive') binName = 'ai-hive-mcp'; // npx 形态：取 npm bin 唯一键
  let binPath;
  try { binPath = resolveBinPath(meta, binName); }
  catch (e) { report.skipped.push({ id, reason: e.message }); console.error('SKIP ' + id + ': ' + e.message); continue; }
  if (path.isAbsolute(binPath) || binPath.includes('..') || /^[A-Za-z]:/.test(binPath) || binPath.startsWith('/') || binPath.startsWith('\\')) {
    report.skipped.push({ id, reason: 'binPath 非法: ' + binPath }); console.error('SKIP ' + id + ': binPath 非法'); continue;
  }

  const spec = {
    package: pkg,
    version: meta.version,
    binName,
    binPath,
  };
  // runtime: WB cli.json 的 runtime.type 均为 node；CliSpec.runtime 是 "native" 才特殊，node 缺省即可。
  // npmEnv：只保留功能型 env，剔除任何 workbuddy 渠道身份（值/键含 workbuddy 一律不落）。
  if (cli.env) {
    const env = {};
    for (const [k, v] of Object.entries(cli.env)) {
      if (/workbuddy/i.test(k) || /workbuddy/i.test(String(v))) continue;
      env[k] = String(v);
    }
    if (Object.keys(env).length) spec.npmEnv = env;
  }
  const authArgv = tailArgv(authT, AUTH_ARGV_OVERRIDES, id)
    .filter((a) => !WB_UI_FLAGS[id]?.has(a));
  const auth = {
    argv: authArgv,
    urlDomain: typeof cli.authUrlDomain === 'string' ? cli.authUrlDomain : '',
    waitForExit: cli.authWaitForExit === true,
  };
  // qrPngArg：仅当 argv 显式带 --output-qrcode <path> 时声明（本批无；保留通用逻辑）。
  const qrIdx = authArgv.findIndex((a) => QR_PNG_ARGS.has(a));
  if (qrIdx >= 0) {
    auth.qrPngArg = authArgv[qrIdx];
    auth.argv[qrIdx + 1] = '{qr}';
  }
  spec.auth = auth;
  const status = { argv: tailArgv(statusT, STATUS_ARGV_OVERRIDES, id) };
  const override = STATUS_MATCH_OVERRIDES[id];
  if (override) {
    // 覆盖形态：忽略 WB 的 statusMatch（那是包装器输出的标记串）。
    Object.assign(status, JSON.parse(JSON.stringify(override)));
  } else {
    if (cli.statusMatchJson && typeof cli.statusMatchJson === 'object') {
      status.matchJson = {};
      for (const [k, v] of Object.entries(cli.statusMatchJson)) status.matchJson[k] = String(v);
    }
    if (typeof cli.statusMatch === 'string' && cli.statusMatch) status.matchRegex = cli.statusMatch;
  }
  if (!status.matchJson && !status.matchRegex) {
    if (!STATUS_FALLBACK_REGEX[id]) {
      report.skipped.push({ id, reason: 'WB 无 statusMatch/statusMatchJson 且无兜底正则' });
      console.error('SKIP ' + id + ': 无状态匹配器'); continue;
    }
    status.matchRegex = STATUS_FALLBACK_REGEX[id];
    report.noStatusMatcherIds.push(id);
  }
  // 形态门禁：argv 带 --json 却用「整段锚定标记串」正则 = 包装器语义被错搬
  // （直跑 CLI 输出 JSON，永远不匹配）。这类组合必须 FATAL，不得随发版。
  if (status.argv.includes('--json') && typeof status.matchRegex === 'string'
      && !status.matchJson && /^\^/.test(status.matchRegex) && /\$/.test(status.matchRegex)
      && !/[{[]/.test(status.matchRegex)) {
    throw new Error(id + ': --json 状态命令不得配整段锚定标记串正则 ' + status.matchRegex);
  }
  // 正则必须是合法 Rust regex（JS RegExp 近似校验；转义来自 WB 原文）。
  try { new RegExp(status.matchRegex || '(?!)'); }
  catch (e) { report.skipped.push({ id, reason: 'statusMatch 正则非法: ' + e.message }); console.error('SKIP ' + id + ': 正则非法'); continue; }
  spec.status = status;
  spec.unauth = { argv: tailArgv(unauthT, UNAUTH_ARGV_OVERRIDES, id) };

  const specJson = JSON.stringify(spec);
  if (/workbuddy|callerUmt|--source/i.test(specJson)) {
    report.skipped.push({ id, reason: 'cli_spec 含渠道参数' }); console.error('SKIP ' + id + ': cli_spec 含渠道参数'); continue;
  }

  // 展示数据：直接取 WB 原文 + 品牌整词 debrand；缺字段用 name 兜底，不编造功能描述。
  const nameZh = debrandDisplay(d.name || pj.name || id);
  const nameEn = debrandDisplay(d.name_en || nameZh);
  const descZh = debrandDisplay(d.description_zh || d.description_en || pj.description || '');
  const descEn = debrandDisplay(d.description_en || d.description_zh || pj.description || '');
  const descGeneric = descZh || descEn || '厂商官方 CLI 连接器。';
  const display = {
    name: nameZh, name_en: nameEn,
    description_zh: descZh || descGeneric, description_en: descEn || descGeneric,
  };

  // 技能：复制 roots（含 SKILL.md 的目录；ai-hive 的共享 references/ 复制到每个技能根下，
  // 保持 ../references/* 相对引用在内核落盘后仍可解析）；顶层文件并入每个技能根（不新增技能根）。
  const skillsSrc = path.join(base, 'skills');
  const entries = fs.readdirSync(skillsSrc, { withFileTypes: true });
  const roots = entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(skillsSrc, e.name, 'SKILL.md'))).map((e) => e.name).sort();
  const sharedDirs = entries.filter((e) => e.isDirectory() && !roots.includes(e.name)).map((e) => e.name);
  const topFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
  if (!roots.length) { report.skipped.push({ id, reason: '技能源无 SKILL.md 根' }); console.error('SKIP ' + id + ': 无技能'); continue; }
  const destRoot = path.join(OUT, id, 'skills');
  if (!DRY) {
    fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
    fs.mkdirSync(path.join(OUT, id, '.gwork-plugin'), { recursive: true });
    fs.mkdirSync(destRoot, { recursive: true });
  }
  const manifest = [];
  let fileCount = 0, byteCount = 0, fallbackUsed = false;
  for (const skillDir of roots) {
    const outSkillDir = debrandDirName(skillDir);
    const to = path.join(destRoot, outSkillDir);
    if (!DRY) fs.mkdirSync(to, { recursive: true });
    const from = path.join(skillsSrc, skillDir);
    for (const file of walkFiles(from)) {
      const rel = path.relative(from, file).split(path.sep).join('/');
      if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) throw new Error('技能路径不安全: ' + file);
      const dest = path.join(to, rel);
      if (!DRY) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (isTextFile(file)) fs.writeFileSync(dest, debrandSkillText(fs.readFileSync(file, 'utf8')));
        else fs.copyFileSync(file, dest);
        fileCount++; byteCount += fs.statSync(dest).size;
      } else { fileCount++; byteCount += fs.statSync(file).size; }
    }
    // 共享 references/ 与顶层散文件并入每个技能根（保持相对引用；不生成额外技能根）。
    // ai-hive 的 10 个技能都引用 ../references/*，内核按 zip 内路径平铺解包，
    // 每个技能根各带一份才能保证任意技能单独解包时引用不落空；体积代价
    // 约 0.35MiB（源数据 0.24MiB → 0.60MiB），以数据正确性优先。
    for (const sd of sharedDirs) {
      const sFrom = path.join(skillsSrc, sd);
      for (const file of walkFiles(sFrom)) {
        const rel = sd + '/' + path.relative(sFrom, file).split(path.sep).join('/');
        const dest = path.join(to, rel);
        if (!DRY) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (isTextFile(file)) fs.writeFileSync(dest, debrandSkillText(fs.readFileSync(file, 'utf8')));
          else fs.copyFileSync(file, dest);
          fileCount++; byteCount += fs.statSync(dest).size;
        } else { fileCount++; byteCount += fs.statSync(file).size; }
      }
    }
    for (const f of topFiles) {
      const src = path.join(skillsSrc, f), dest = path.join(to, f);
      if (!DRY) {
        if (isTextFile(src)) fs.writeFileSync(dest, debrandSkillText(fs.readFileSync(src, 'utf8')));
        else fs.copyFileSync(src, dest);
        fileCount++; byteCount += fs.statSync(dest).size;
      } else { fileCount++; byteCount += fs.statSync(src).size; }
    }
    // LICENSE：源自带则原样保留；缺则补 npm license 字段文本（查不到用兜底文案）。
    if (!fs.existsSync(path.join(to, 'LICENSE'))) {
      const text = licenseText(meta.license, pkg);
      if (!DRY) fs.writeFileSync(path.join(to, 'LICENSE'), text);
      fileCount++; byteCount += Buffer.byteLength(text);
      if (!meta.license || /^\s*$/.test(meta.license)) fallbackUsed = true;
    }
    manifest.push({ name: outSkillDir, dir: 'skills/' + outSkillDir });
  }
  if (fallbackUsed) report.fallbackLicenseIds.push(id);
  if (DEV_FLOW_IDS.has(id)) report.deviceFlowIds.push(id);

  const licenseLabel = meta.license || 'UNLICENSED';
  const provenance = {
    source: pkg + '@' + meta.version + ' 官方技能（WB 公开仓库缓存 skills/ 原样复制，缺 LICENSE 由 npm license 字段补齐）',
    url: 'https://www.npmjs.com/package/' + pkg,
    license: licenseLabel,
    skillCount: manifest.length,
    fileCount,
    byteCount,
  };
  const plugin = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: id,
    version: '1.0.0',
    description: descEn || descGeneric,
    keywords: ['cli', 'skills'],
    extensions: {
      'cn.gourd.gwork': {
        schemaVersion: '1.0.0',
        kind: 'cli',
        tier: 'cli',
        auth: { authType: 'cli_login' },
        display,
        categories: [CATEGORIES[id]],
        source: 'vendor-cli:' + pkg + '@' + meta.version,
        cli_spec: spec,
        skills: manifest,
        skills_provenance: provenance,
        readme: readme(id, pkg, meta.version, nameZh, manifest.length),
      },
    },
  };
  if (!DRY) fs.writeFileSync(path.join(OUT, id, '.gwork-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n');
  report.generated.push({ id, package: pkg + '@' + meta.version, binName, binPath, license: licenseLabel, skills: manifest.length, fileCount, byteCount, deviceFlow: DEV_FLOW_IDS.has(id), fallbackStatusRegex: report.noStatusMatcherIds.includes(id) });
}
if (!DRY) fs.writeFileSync(path.join(ROOT, 'scripts', 'import-wb-cli-batch.report.json'), JSON.stringify(report, null, 2) + '\n');
console.log('generated:', report.generated.length, 'skipped:', report.skipped.length);
for (const g of report.generated) console.log('  ' + g.id.padEnd(26), g.package.padEnd(42), g.binName.padEnd(16), g.binPath);
for (const s of report.skipped) console.log('  SKIP', s.id, s.reason);
if (report.skipped.length) process.exit(1);
