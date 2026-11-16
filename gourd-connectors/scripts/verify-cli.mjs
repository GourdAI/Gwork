#!/usr/bin/env node
// verify-cli.mjs — CLI 连接器数据契约验证（独立于生成管线，直接审 dist 产物）。
// 检查：条目数/形态、cli_spec 完整性与 argv 纪律（含 skipIf 字符串数组、
//   binPath 路径安全、Rust serde 形态模拟）、skills_zip base64→zip 解包
// （CRC/路径安全/SKILL.md 根部/LICENSE）、zip 与磁盘技能逐字节一致、护栏、
// featured-source 同步、dist/内核明文/gzip 三份字节一致、debrand 与渠道参数残留。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIB = 1024 * 1024;
const ZIP_B64_MAX_PER_ENTRY = 16 * MIB; // 与 build-snapshot 一致：全内置无 8MiB 传输限额
const ZIP_B64_MAX_TOTAL = 64 * MIB;
let failures = 0;
const ok = (m) => console.log('  ok:', m);
const fail = (m) => { failures++; console.error('  FAIL:', m); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

const distPath = path.join(ROOT, 'dist', 'registry.json');
const kernelPath = path.join(ROOT, '..', 'gourd-work', 'core', 'src', 'mcp', 'registry.json');
const kernelGzPath = path.join(ROOT, '..', 'gourd-work', 'core', 'src', 'mcp', 'registry.json.gz');
const distBuf = fs.readFileSync(distPath);
const reg = JSON.parse(distBuf.toString('utf8'));

console.log('[1] 快照总体');
check(reg.entries.length === 203, 'entries=203（实际 ' + reg.entries.length + '）');
const ids = new Set(reg.entries.map((e) => e.id));
check(ids.size === reg.entries.length, 'id 无重复');
check(!ids.has('official:dingtalk-mcp'), '无旧钉钉 stdio 残留 id');
const sorted = [...reg.entries].every((e, i, a) => i === 0 || a[i - 1].id <= e.id);
check(sorted, 'codepoint 稳定排序');
const payloadHash = crypto.createHash('sha256').update(JSON.stringify({ entries: reg.entries })).digest('hex').slice(0, 16);
check(reg.version === '1.' + payloadHash, 'version=内容哈希 (' + reg.version + ')');
check(Buffer.compare(distBuf, fs.readFileSync(kernelPath)) === 0, 'dist 与内核快照字节一致');
// gzip 内嵌真源：include_bytes!("registry.json.gz") 解压后必须与明文逐字节一致。
const gzBuf = fs.readFileSync(kernelGzPath);
const plainFromGz = zlib.gunzipSync(gzBuf);
check(Buffer.compare(plainFromGz, distBuf) === 0, 'registry.json.gz 解压后与明文字节一致 (' + gzBuf.length + ' bytes)');
const gzReg = JSON.parse(plainFromGz.toString('utf8'));
check(gzReg.version === reg.version && gzReg.generatedAt === reg.generatedAt && JSON.stringify(gzReg.entries) === JSON.stringify(reg.entries), 'gz/明文 version+generatedAt+entries 一致');

console.log('[2] CLI 条目契约');
// 28 条 CLI：4 条已实测可连 + 24 条从 WB 公开仓库导入的公开可连候选。
// 动态从快照取（不再硬编码 4 条名单），核心 4 条仍逐项断言必在，防重跑导入丢失。
const CORE_CLI = ['official:dingtalk', 'official:feishu', 'official:wecom', 'official:tmeet'];
const cliEntries = reg.entries.filter((e) => e.kind === 'cli');
check(cliEntries.length === 28, 'cli 条数=28（实际 ' + cliEntries.length + '）');
check(CORE_CLI.every((id) => ids.has(id)), '核心 4 个 CLI id 齐全');
check(ids.has('official:tencent-meeting'), '腾讯会议 token MCP 条目保留');
const tm = reg.entries.find((e) => e.id === 'official:tencent-meeting');
check(tm && tm.kind === undefined && tm.server_config.length === 1, 'tencent-meeting 仍为 MCP 形态');

let zipTotal = 0;
for (const e of cliEntries) {
  const name = e.id.slice('official:'.length);
  console.log('  --', name);
  check(e.tier === 'cli' && e.auth_kind === 'cli_login', 'tier/auth_kind');
  check(Array.isArray(e.server_config) && e.server_config.length === 0, 'server_config=[]');
  check(!fs.existsSync(path.join(ROOT, 'connectors', name, 'mcp.json')), '无 mcp.json');
  const s = e.cli_spec;
  check(s && typeof s.package === 'string' && typeof s.version === 'string' && typeof s.binName === 'string' && typeof s.binPath === 'string', 'cli_spec 基础字段');
  // P1 形态护栏：binPath 不得含 ../、不得绝对/UNC/盘符（内核 registry.rs 同款拒绝）。
  check(!path.isAbsolute(s.binPath) && !s.binPath.includes('..') && !/^[A-Za-z]:/.test(s.binPath) && !s.binPath.startsWith('/') && !s.binPath.startsWith('\\'), 'binPath 包内相对路径（无 ../ 绝对/UNC/盘符）');
  // P1 形态护栏：所有 argv 必须是字符串数组；skipIf 存在时必须是字符串数组
  // （绝不能是对象 {argv:[...]} —— Rust CliAuthStep.skip_if 是 Option<Vec<String>>）。
  const isArgv = (v) => Array.isArray(v) && v.every((a) => typeof a === 'string');
  // unauth 可为空对象（企微：内核仅清本地态），此时 argv 缺省合法；存在则必须数组。
  const unauthArgvOk = !!s.unauth && typeof s.unauth === 'object' && (s.unauth.argv === undefined || isArgv(s.unauth.argv));
  check(isArgv(s.status && s.status.argv) && unauthArgvOk, 'status.argv / unauth.argv 字符串数组');
  const steps = s.authSteps || [s.auth];
  check(steps.every((st) => st && isArgv(st.argv) && st.argv.length && typeof st.urlDomain === 'string'), 'auth argv 数组 + urlDomain');
  const badSkip = steps.filter((st) => st && st.skipIf !== undefined && !isArgv(st.skipIf));
  check(badSkip.length === 0, 'authSteps[].skipIf 字符串数组（不得是对象）' + (badSkip.length ? ' bad=' + JSON.stringify(badSkip.map((x) => x.skipIf)) : ''));
  // Rust serde 形态模拟：CliSpec/CliAuthStep/CliStatusCmd/CliUnauth 的字段类型。
  // skipIf 为对象时整体解析失败（官方:feishu 100% 不可用），此处直接 FAIL。
  const rustShapeOk = !!(s && typeof s.package === 'string' && typeof s.version === 'string'
    && typeof s.binPath === 'string'
    && (!s.npmEnv || (typeof s.npmEnv === 'object' && !Array.isArray(s.npmEnv) && Object.values(s.npmEnv).every((v) => typeof v === 'string')))
    && (!s.runtime || typeof s.runtime === 'string')
    && (!s.auth || (isArgv(s.auth.argv) && typeof s.auth.urlDomain === 'string' && (s.auth.waitForExit === undefined || typeof s.auth.waitForExit === 'boolean') && (s.auth.qrPngArg === undefined || typeof s.auth.qrPngArg === 'string')))
    && (!s.authSteps || (Array.isArray(s.authSteps) && s.authSteps.every((st) => isArgv(st.argv) && typeof st.urlDomain === 'string' && (st.waitForExit === undefined || typeof st.waitForExit === 'boolean') && (st.qrPngArg === undefined || typeof st.qrPngArg === 'string') && (st.skipIf === undefined || isArgv(st.skipIf)))))
    && (isArgv(s.status.argv) && (!s.status.matchJson || (typeof s.status.matchJson === 'object' && !Array.isArray(s.status.matchJson))) && (s.status.matchRegex === undefined || typeof s.status.matchRegex === 'string'))
    && (s.unauth === undefined || (s.unauth && typeof s.unauth === 'object' && !Array.isArray(s.unauth) && (s.unauth.argv === undefined || isArgv(s.unauth.argv)))));
  check(rustShapeOk, 'Rust CliSpec serde 形态模拟（skipIf 对象直接 FAIL）');
  check(s.status && (s.status.matchJson || s.status.matchRegex), 'status 匹配器存在');
  // P0 语义门禁：--json 状态命令不得配「整段锚定标记串」正则。
  // WB 的 gaoding 用 node -e 包装器把 JSON 转成 GD_AUTHENTICATED 再匹配；
  // GWork 直跑 CLI 拿到的是 JSON，照搬该正则会授权成功仍判未授权。
  const anchoredMarker = s.status && s.status.argv.includes('--json')
    && !s.status.matchJson && typeof s.status.matchRegex === 'string'
    && /^\^/.test(s.status.matchRegex) && /\$/.test(s.status.matchRegex)
    && !/[{[]/.test(s.status.matchRegex);
  check(!anchoredMarker, name + ': --json 状态命令不得配包装器标记串正则');
  check(s.unauth && typeof s.unauth === 'object', 'unauth 对象');
  const specJson = JSON.stringify(s);
  check(!/workbuddy|callerUmt|--source/i.test(specJson), 'cli_spec 无渠道参数');
  check(e.categories && e.categories.length > 0, 'categories 非空');
  const dispJson = JSON.stringify(e.locales) + e.description;
  check(!/workbuddy/i.test(dispJson), 'display 已 debrand');

  // skills_zip
  check(typeof e.skills_zip === 'string' && e.skills_zip.length > 0, 'skills_zip 存在');
  check(e.skills_zip.length <= ZIP_B64_MAX_PER_ENTRY, '单条 base64 ≤16MiB (' + e.skills_zip.length + ')');
  zipTotal += e.skills_zip.length;
  const zip = Buffer.from(e.skills_zip, 'base64');
  let files;
  try { files = readZip(zip); ok('zip 可解（CRC/路径安全通过），条目 ' + files.length); }
  catch (err) { fail('zip 解包失败: ' + err.message); continue; }
  const byName = new Map(files.map((f) => [f.name, f.data]));
  check(Array.isArray(e.skills) && e.skills.length > 0, 'skills 清单非空 (' + e.skills.length + ')');
  for (const sk of e.skills) {
    const root = sk.dir + '/';
    check(byName.has(root + 'SKILL.md'), sk.name + ': SKILL.md 在技能目录根部');
    check(byName.has(root + 'LICENSE'), sk.name + ': LICENSE 存在');
    const lic = byName.get(root + 'LICENSE');
    if (lic) {
      const t = lic.toString('utf8');
      // 核心 4 条沿用厂商许可全文（Apache/MIT）；新增 24 条按用户要求写
      // `npm view <pkg> license` 实测字段文本（或查不到时的兜底文案）。
      // 不伪造许可全文；兜底文案以 UNLICENSED — 开头。两种形态都合法。
      const licensed = /Apache License|MIT License|Permission is hereby granted|ISC License/i.test(t)
        || /^(MIT|ISC|Apache-2\.0|UNLICENSED|BSD-[0-9]-Clause|GPL-[0-9.]+(-or-later)?|MPL-2\.0|LGPL-[0-9.]+(-or-later)?|CC-BY-[0-9.]+|WTFPL|Unlicense|SEE LICENSE IN|UNLICENSED —)/im.test(t.trim());
      check(licensed, sk.name + ': LICENSE 为许可全文或 npm license 实测字段/兜底文案');
    }
    // zip ↔ 磁盘逐字节一致
    const diskRoot = path.join(ROOT, 'connectors', name, sk.dir);
    const diskFiles = [];
    const walk = (d, prefix) => {
      for (const en of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, en.name);
        if (en.isDirectory()) walk(p, prefix + en.name + '/');
        else diskFiles.push([prefix + en.name, fs.readFileSync(p)]);
      }
    };
    walk(diskRoot, root);
    const zipSubset = files.filter((f) => f.name.startsWith(root));
    check(zipSubset.length === diskFiles.length, sk.name + ': 文件数一致 zip=' + zipSubset.length + ' disk=' + diskFiles.length);
    let same = true;
    for (const [rel, data] of diskFiles) {
      const z = byName.get(rel);
      if (!z || Buffer.compare(z, data) !== 0) { same = false; fail(sk.name + ': 字节不一致 ' + rel); break; }
    }
    if (same) ok(sk.name + ': zip 与磁盘逐字节一致');
    // 技能文本 debrand（品牌词整词；小写枚举值属命令语法不在检查范围）
    let brandLeak = false;
    for (const f of zipSubset) {
      if (/\.(md|txt|json|py|js)$/i.test(f.name) && /WorkBuddy/.test(f.data.toString('utf8'))) { brandLeak = true; fail(sk.name + ': 品牌残留 ' + f.name); }
    }
    if (!brandLeak) ok(sk.name + ': 无 WorkBuddy 品牌残留');
  }
  // zip 内不得有清单之外的技能根（zip 路径带 "skills/" 前缀，按两级取根）
  const roots = new Set(files.map((f) => f.name.split('/').slice(0, 2).join('/')));
  check(roots.size === e.skills.length, 'zip 技能根数=清单数 (' + roots.size + '/' + e.skills.length + ')');
}
check(zipTotal <= ZIP_B64_MAX_TOTAL, '全表 base64 ≤64MiB（全内置无传输限额）(' + zipTotal + ')');

console.log('[3] featured-source 同步');
const featured = JSON.parse(fs.readFileSync(path.join(ROOT, 'featured-source.json'), 'utf8'));
check(!featured.entries.some((e) => e.id === 'featured:dingtalk'), 'featured:dingtalk 已移除');
check(featured.entries.some((e) => e.id === 'featured:tencent-meeting'), 'featured:tencent-meeting 保留');

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures);
process.exit(failures === 0 ? 0 : 1);