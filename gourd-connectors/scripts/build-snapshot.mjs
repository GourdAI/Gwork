// build-snapshot.mjs — connectors/* → dist/registry.json + 内核内置快照。
// 产物形态与内核 mcp::registry 的解析契约一致（entries 与魔搭详情同形）：
//   { version, generatedAt, entries: [{ id:"official:<name>", name, chinese_name,
//     description, locales, categories, source:"official", auth_kind?, tier,
//     server_config:[{mcpServers}], env_schema?, readme? }] }
// CLI 形态条目（无 mcp.json、plugin 带 kind:"cli"+cli_spec）：server_config=[]，
//   条目带 kind:"cli"、cli_spec、skills（清单）、skills_zip（技能目录 store/deflate
//   zip 的 base64，零依赖手写，格式与内核 skills/market.rs 解包器兼容）。
//   护栏：单条 skills_zip base64 ≤16MiB（防异常/zip bomb 的合理性检查）、
//   全表 ≤64MiB；目录数/CLI 条数不足直接 FATAL（禁止静默 skip）。
// 2026-11 用户拍板：全部桌面端内置随发版，彻底删除 admin 上传/远程增量链路。
// 原 6/7/8MiB 三档护栏是「远程 HTTP feed 上传」的传输限额；客户端改为
// include_bytes! 编译期直接内嵌 gzip 整份（会话实测 gzip 可把体积压下来），
// 已无 8MiB 传输限额，故整体放宽为单条 16MiB / 全表 64MiB 的合理性检查
// （防异常技能包/zip bomb，不是传输约束）。明文 dist/registry.json 与内核
// registry.json 继续写，供审计/契约测试；registry.json.gz 才是 Rust 内嵌真源。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildZip } from './zip-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'connectors');
const KERNEL_SNAPSHOT = path.join(ROOT, '..', 'gourd-work', 'core', 'src', 'mcp', 'registry.json');
// Rust registry.rs 用 include_bytes! 编译期内嵌这份 gzip；解压后必须与明文逐字节一致。
const KERNEL_GZ = path.join(ROOT, '..', 'gourd-work', 'core', 'src', 'mcp', 'registry.json.gz');
const DIST_SNAPSHOT = path.join(ROOT, 'dist', 'registry.json');
const MIB = 1024 * 1024;
// 单条技能 zip 合理性护栏（防异常数据/zip bomb），不再是传输限额。
const ZIP_B64_MAX_PER_ENTRY = 16 * MIB;
const ZIP_B64_MAX_TOTAL = 64 * MIB;
const SNAPSHOT_MAX_BYTES = 64 * MIB;
const EXPECTED_CONNECTOR_DIRS = 203; // 来源：179 条既有目录 + 本轮 24 条 WB 公开 CLI 候选 = 203
const EXPECTED_CLI_ENTRIES = 28;    // 来源：既有 4 条（dingtalk/feishu/wecom/tmeet）+ 本轮 24 条 = 28

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// 技能目录 → zip（稳定排序；SKILL.md 必须在技能目录根部；路径安全由 zip-store 断言）
function packSkills(name, skills) {
  const files = [];
  for (const s of skills) {
    const dir = path.join(SRC, name, s.dir);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      throw new Error('cli 条目 ' + name + ' 技能 ' + s.dir + ' 根部缺 SKILL.md');
    }
    const walk = (d, prefix) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const p = path.join(d, e.name);
        const rel = prefix + e.name;
        if (e.isSymbolicLink()) throw new Error('技能含符号链接: ' + p);
        if (e.isDirectory()) walk(p, rel + '/');
        else if (e.isFile()) files.push({ name: rel, data: fs.readFileSync(p) });
      }
    };
    walk(dir, s.dir + '/');
  }
  if (!files.length) return null;
  return buildZip(files);
}

const entries = [];
let zipB64Total = 0;
const cliNames = [];
let malformed = 0;
let dirCount = 0;
for (const dir of fs.readdirSync(SRC, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  dirCount++;
  const name = dir.name;
  const mcp = readJson(path.join(SRC, name, 'mcp.json'));
  const plugin = readJson(path.join(SRC, name, '.gwork-plugin', 'plugin.json'));
  const gw = plugin && plugin.extensions && plugin.extensions['cn.gourd.gwork'];
  if (!gw) { malformed++; console.error('FATAL malformed:', name, 'plugin.json 缺 cn.gourd.gwork 扩展'); continue; }
  const d = gw.display || {};

  // ── CLI 形态：无 mcp.json，kind:"cli" + cli_spec ─────────────────────────
  if (!mcp) {
    if (gw.kind !== 'cli' || !gw.cli_spec) { malformed++; console.error('FATAL malformed:', name, 'CLI 形态缺 kind/cli_spec'); continue; }
    const spec = gw.cli_spec;
    // 契约自检：argv 数组形态、必备字段齐全（数据层护栏，内核另有白名单校验）。
    // P0 回归：skipIf 必须是字符串数组（Rust CliAuthStep.skip_if: Option<Vec<String>>），
    // 写成对象 {argv:[...]} 会导致 serde 整体解析失败、连接器 100% 不可用。
    for (const k of ['package', 'version', 'binName', 'binPath']) {
      if (typeof spec[k] !== 'string' || !spec[k]) throw new Error(name + ' cli_spec 缺 ' + k);
    }
    if (spec.binPath.includes('..') || path.isAbsolute(spec.binPath) || /^[A-Za-z]:/.test(spec.binPath) || spec.binPath.startsWith('/') || spec.binPath.startsWith('\\')) {
      throw new Error(name + ' cli_spec.binPath 非法（不得含 ../绝对路径/盘符）: ' + spec.binPath);
    }
    const isArgv = (v) => Array.isArray(v) && v.every((a) => typeof a === 'string');
    const steps = spec.authSteps || (spec.auth ? [spec.auth] : []);
    if (!steps.length) throw new Error(name + ' cli_spec 缺 auth/authSteps');
    for (const st of steps) {
      if (!isArgv(st.argv) || !st.argv.length) throw new Error(name + ' auth argv 非法（须为字符串数组）');
      if (st.skipIf !== undefined && !isArgv(st.skipIf)) throw new Error(name + ' auth skipIf 非法（须为字符串数组，不得是对象）');
    }
    for (const part of [spec.status, spec.unauth]) {
      if (part && part.argv && !isArgv(part.argv)) throw new Error(name + ' status/unauth argv 非法（须为字符串数组）');
    }
    const skills = Array.isArray(gw.skills) ? gw.skills : [];
    const entry = {
      id: 'official:' + name,
      name: d.name_en || name,
      chinese_name: d.name || d.name_en || name,
      description: d.description_zh || d.description_en || plugin.description || '',
      locales: {
        zh: { name: d.name || name, description: d.description_zh || '' },
        en: { name: d.name_en || name, description: d.description_en || '' },
      },
      categories: gw.categories || ['other'],
      source: 'official',
      tier: 'cli',
      auth_kind: 'cli_login',
      kind: 'cli',
      cli_spec: spec,
      skills,
      server_config: [],
    };
    const zip = packSkills(name, skills);
    if (zip) {
      const b64 = zip.toString('base64');
      if (b64.length > ZIP_B64_MAX_PER_ENTRY) {
        console.error('FATAL: ' + name + ' skills_zip base64 ' + b64.length + ' 超单条护栏 ' + ZIP_B64_MAX_PER_ENTRY);
        process.exit(1);
      }
      zipB64Total += b64.length;
      entry.skills_zip = b64;
    }
    if (gw.readme) entry.readme = gw.readme;
    entries.push(entry);
    cliNames.push(name);
    continue;
  }

  if (!mcp.mcpServers) { malformed++; console.error('FATAL malformed:', name, 'mcp.json 缺 mcpServers'); continue; }
  const first = Object.values(mcp.mcpServers)[0] || {};
  const authKind = (first.auth && first.auth.authType) || (gw.auth && gw.auth.authType) || 'none';
  // 契约：每个 http 型 server 配置必须带非密钥 auth 声明（内核 registry 测试
  // 钉死）。免鉴权条目补 {authType:"none"}；oauth 条目把 plugin 级声明落进 cfg。
  for (const cfg of Object.values(mcp.mcpServers)) {
    const isHttp = !cfg.command && !!cfg.url;
    if (isHttp && !cfg.auth) {
      cfg.auth = authKind === 'oauth'
        ? { authType: 'oauth', tokenLabel: d.name || d.name_en || name }
        : { authType: 'none' };
    }
  }
  const entry = {
    id: 'official:' + name,
    name: d.name_en || name,
    chinese_name: d.name || d.name_en || name,
    description: d.description_zh || d.description_en || plugin.description || '',
    locales: {
      zh: { name: d.name || name, description: d.description_zh || '' },
      en: { name: d.name_en || name, description: d.description_en || '' },
    },
    categories: gw.categories || ['other'],
    source: 'official',
    tier: gw.tier || 'open',
    auth_kind: authKind,
    server_config: [{ mcpServers: mcp.mcpServers }],
  };
  if (gw.env_schema) entry.env_schema = gw.env_schema;
  if (gw.readme) entry.readme = gw.readme;
  entries.push(entry);
}
// P0 幂等护栏：目录数不足或 cli 条数不对时直接 FATAL 退出（禁止静默 skip）。
if (dirCount < EXPECTED_CONNECTOR_DIRS) {
  console.error('FATAL: connectors/ 目录数 ' + dirCount + ' < ' + EXPECTED_CONNECTOR_DIRS + '（重跑导入可能删掉了 CLI/featured 条目），拒绝生成残缺快照');
  process.exit(1);
}
if (cliNames.length !== EXPECTED_CLI_ENTRIES) {
  console.error('FATAL: cli 条数 ' + cliNames.length + ' != ' + EXPECTED_CLI_ENTRIES + '（' + cliNames.join(',') + '），拒绝生成残缺快照');
  process.exit(1);
}
if (malformed) {
  console.error('FATAL: ' + malformed + ' 个 connectors/ 目录形态非法，拒绝生成残缺快照');
  process.exit(1);
}
if (zipB64Total > ZIP_B64_MAX_TOTAL) {
  console.error('FATAL: skills_zip base64 合计 ' + zipB64Total + ' 超全表护栏 ' + ZIP_B64_MAX_TOTAL);
  process.exit(1);
}
// 排序用 codepoint 比较（localeCompare 依赖 ICU locale，跨平台可能漂移，
// 导致同内容不同序 → 内容哈希版本无意义抖动）。
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const payload = { entries };
const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
const version = '1.' + hash;
// P1 幂等：entries 内容哈希未变时复用现有 generatedAt，同内容重跑字节完全一致。
// 只有内容变化（或 GWORK_REGISTRY_FORCE_TS=1）才刷新时间戳。
const old = readJson(DIST_SNAPSHOT);
const forceTs = process.env.GWORK_REGISTRY_FORCE_TS === '1';
const reuseTs = !forceTs && old && old.version === version && typeof old.generatedAt === 'string';
const generatedAt = reuseTs ? old.generatedAt : new Date().toISOString();
if (reuseTs) console.log('generatedAt: 复用现有值（entries 哈希未变，字节幂等）' + old.generatedAt);
else console.log('generatedAt: 刷新为 ' + generatedAt + (forceTs ? '（GWORK_REGISTRY_FORCE_TS=1）' : '（entries 内容变化）'));
const registry = { version, generatedAt, ...payload };
const text = JSON.stringify(registry, null, 2) + '\n';
const textBytes = Buffer.byteLength(text);
if (textBytes > SNAPSHOT_MAX_BYTES) {
  console.error('FATAL: 最终快照 ' + textBytes + ' bytes 超过总量护栏 ' + SNAPSHOT_MAX_BYTES + '，拒绝写入');
  process.exit(1);
}

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(DIST_SNAPSHOT, text);
fs.writeFileSync(KERNEL_SNAPSHOT, text);
// gzip 内嵌真源：mtime=0 保证同内容重跑字节稳定；Rust registry.rs 的
// include_bytes!("registry.json.gz") 直接编译这份文件，桌面契约 ㉓ 钉死
// gunzip(gz) === 明文 registry.json。
const gz = zlib.gzipSync(Buffer.from(text, 'utf8'), { level: 9, mtime: 0 });
fs.writeFileSync(KERNEL_GZ, gz);
console.log('entries:', entries.length, 'cli:', cliNames.length, '(' + cliNames.join(',') + ')', 'version:', registry.version);
console.log('skills_zip base64 total:', zipB64Total, 'bytes; snapshot:', textBytes, 'bytes; gzip:', gz.length, 'bytes (ratio ' + (gz.length / textBytes).toFixed(3) + ')');
console.log('dist/registry.json +', path.relative(ROOT, KERNEL_SNAPSHOT), '+', path.relative(ROOT, KERNEL_GZ), '(gzip mtime=0, 字节幂等)');