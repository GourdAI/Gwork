#!/usr/bin/env node
// import-cli.mjs — 生成 4 条 CLI 形态官方连接器（数据层，P0.5 契约第七节）。
// 钉钉/飞书/企业微信/腾讯会议：厂商官方 npm CLI + 扫码授权 + 官方技能包。
// 输出: connectors/<name>/.gwork-plugin/plugin.json + connectors/<name>/skills/**
//   （CLI 形态不写 mcp.json —— 无 MCP 端点，server_config 由 build-snapshot 置 []）
// 同步: featured-source.json 删除旧 featured:dingtalk（stdio 手填凭证形态，被
//   CLI 扫码形态替换）；official:tencent-meeting（token MCP）保留，tmeet 独立新增。
// 可重跑且**无需 WorkBuddy 安装**：display/cli_spec 基底优先读已入库的
//   connectors/<name>/.gwork-plugin/plugin.json；技能优先读已入库的
//   connectors/<name>/skills/（先复制暂存再回写，避免"先删后读"丢真源）；
//   本机 WB 缓存只是可选刷新源（缺失不 throw），.cli-src/ 暂存与网络拉取仅兜底。
//   全程零 npm 依赖。
// 渠道纪律：--source workbuddy / callerUmt 等渠道参数一律不带；技能内 CLI 枚举
//   值里的 workbuddy（--agent 渠道枚举）属命令语法，不改。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'connectors');
const STAGE = path.join(ROOT, '.cli-src');
// 本机 WB 缓存：仅作为**可选刷新源**（无 WorkBuddy 安装的机器不得强依赖）。
// GWORK_WB_CONNECTORS / GWORK_TMEET_PROBE 可覆盖路径（换机、清缓存、临时副本实测）。
const WB = process.env.GWORK_WB_CONNECTORS || 'C:\\Users\\51095\\.workbuddy\\plugins\\marketplaces\\workbuddy-connector-plugins-official\\connectors';
// 优先顺序为「已入库真源 > WB 刷新 > 暂存 > 网络」，见 resolveSkillsDir / 主流程。
const TMEET_PROBE = process.env.GWORK_TMEET_PROBE || 'C:\\Users\\51095\\AppData\\Local\\Temp\\gwork-cli-probe\\node_modules\\@tencentcloud\\tmeet';

const report = { generated: [], featuredRemoved: false, warnings: [] };
const warn = (m) => { report.warnings.push(m); console.warn('WARN:', m); };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }
function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error('技能源含符号链接，拒绝: ' + p);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// ── debrand ─────────────────────────────────────────────────────────────────
// 展示文案：WorkBuddy（任意大小写的整词品牌名）→ GWork。
// 技能文案：只动两类——① frontmatter 元数据命名空间 ai.workbuddy.* → ai.gwork.*
// （宿主版本门槛键，非命令语法）；② 散文里的品牌词 WorkBuddy → GWork。
// 小写 workbuddy 出现在 CLI 渠道枚举（--agent workbuddy 等）里 = 命令语法，保留。
function debrandDisplay(text) {
  return String(text || '').replace(/WorkBuddy/gi, 'GWork');
}
function debrandSkillText(text) {
  return String(text)
    .replace(/ai\.workbuddy\./g, 'ai.gwork.')
    .replace(/WorkBuddy/g, 'GWork');
}
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.py', '.js', '.jsx', '.ts', '.css', '.html', '.xml', '.svg', '.yml', '.yaml', '.csv', '.sh']);
function isTextFile(p) {
  const b = path.basename(p);
  if (b === 'LICENSE' || b === 'NOTICE') return false; // 许可证全文不动（法律文本）
  return TEXT_EXT.has(path.extname(p).toLowerCase());
}

// ── 网络拉取（仅原料缺失时） ─────────────────────────────────────────────────
async function download(url, dest) {
  const urls = /github\.com|codeload\.github\.com|raw\.githubusercontent\.com/.test(url)
    ? [url, 'https://gh-proxy.com/' + url] : [url];
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('空响应');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) { lastErr = e; }
  }
  throw new Error('下载失败 ' + url + ': ' + lastErr.message);
}
function extractTgz(tgz, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tgz, '-C', dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tar 解包失败: ' + (r.stderr || r.error));
}
async function fetchTgz(url, tgzName, extractDir) {
  const tgz = path.join(STAGE, tgzName);
  if (!exists(tgz)) await download(url, tgz);
  extractTgz(tgz, extractDir);
}

// ── 技能源解析（已入库真源 → 暂存 → 本机原料 → 网络） ────────────────────────
// P0 幂等：connectors/<name>/skills/ 是已入库真源，必须**先复制到 STAGE** 再允许
// 主流程 rmSync(outDir)。否则「先删后读」会把唯一真源一起删掉（旧实现最后才
// read-back，且 read-back 与 outDir 同路径，删后必然为空）。
async function resolveSkillsDir(name, candidates, fetcher) {
  const checkedIn = path.join(OUT, name, 'skills');
  const staged = path.join(STAGE, name, 'skills');
  const stageFrom = (dir, origin) => {
    fs.mkdirSync(path.join(STAGE, name), { recursive: true });
    fs.rmSync(staged, { recursive: true, force: true });
    fs.cpSync(dir, staged, { recursive: true });
    return { dir: staged, origin };
  };
  // 已入库真源优先：无任何 WorkBuddy 安装/无网络时也能逐字节重建 4 条 CLI。
  if (exists(checkedIn) && walkFiles(checkedIn).length) return stageFrom(checkedIn, 'checked-in');
  if (exists(staged) && walkFiles(staged).length) return { dir: staged, origin: 'staged' };
  for (const c of candidates) {
    if (c.dir && exists(c.dir) && walkFiles(c.dir).length) return stageFrom(c.dir, c.origin);
  }
  if (fetcher) {
    try {
      const dir = await fetcher();
      if (dir && exists(dir) && walkFiles(dir).length) return stageFrom(dir, 'network');
    } catch (e) { warn(name + ' 技能网络拉取失败: ' + e.message); }
  }
  // 已入库真源/暂存/本机缓存/网络均不可用：宁缺毋滥，不伪造技能。
  return null;
}

// ── 四条连接器契约（cli_spec 全部 argv 数组，无自由 shell 字符串） ───────────
// 命令均已实测（win32，node.exe 直跑包内 bin，绕开 cmd shim）。
const SPECS = [
  {
    name: 'dingtalk',
    package: 'dingtalk-workspace-cli', version: '1.0.68',
    binName: 'dws', binPath: 'bin/dws.js',
    npmEnv: { DWS_NO_SKILLS: '1' },
    auth: { argv: ['auth', 'login', '-y', '--no-browser'], urlDomain: 'login.dingtalk.com', waitForExit: true },
    status: { argv: ['auth', 'status'], matchJson: { authenticated: 'true' } },
    unauth: { argv: ['auth', 'reset'] },
    skillsCandidates: [{ dir: path.join(WB, 'dingtalk', 'skills'), origin: 'workbuddy-cache' }],
    skillsFetcher: async () => {
      const dir = path.join(STAGE, 'dws-pkg');
      await fetchTgz('https://registry.npmmirror.com/dingtalk-workspace-cli/-/dingtalk-workspace-cli-1.0.68.tgz', 'dws-1.0.68.tgz', dir);
      const skills = path.join(dir, 'package', 'skills');
      return exists(skills) ? skills : null;
    },
    // dws 技能目录自带 Apache-2.0 LICENSE + NOTICE（随 WB 缓存/npm 包分发），无需补。
    license: null,
    provenance: {
      source: 'dingtalk-workspace-cli@1.0.68 官方技能（WB 公开仓库缓存 skills/dws，自带 LICENSE）',
      url: 'https://www.npmjs.com/package/dingtalk-workspace-cli',
      license: 'Apache-2.0',
    },
    readme: '## 钉钉 CLI 连接器\n\n厂商官方 `dingtalk-workspace-cli`（dws），扫码登录授权，覆盖 AI 表格、考勤、日历、群聊与机器人、通讯录、钉钉文档、云盘、AI 听记、邮箱、OA 审批、日志、待办等全产品能力。\n\n### 连接方式\n\n1. 点击「连接」，GWork 自动准备 Node 运行时并安装官方 CLI；\n2. 弹窗展示钉钉授权链接/二维码，手机钉钉扫码确认；\n3. 授权完成后自动连接。凭据由官方 CLI 自管，GWork 不接触 token。\n\n技能包来源：厂商官方 Apache-2.0 许可技能（含 LICENSE/NOTICE）。',
  },
  {
    name: 'feishu',
    package: '@larksuite/cli', version: '1.0.100',
    binName: 'lark-cli', binPath: 'scripts/run.js',
    // 两步授权（WB cli.json win32 分支翻译；--lang 按 GWork 中文环境取 zh）。
    // 第一步 skipIf：config show 成功（已有配置）则跳过 init。
    // 注：WB 原命令容忍 auth login 退出码 3（shell || 分支）；argv 形态不携带
    // shell 语义，内核以 waitForExit + status 复核为准（见交付报告）。
    authSteps: [
      { argv: ['config', 'init', '--new', '--lang', 'zh'], urlDomain: 'open.feishu.cn', waitForExit: true, skipIf: ['config', 'show'] },
      { argv: ['auth', 'login', '--recommend'], urlDomain: 'accounts.feishu.cn', waitForExit: true },
    ],
    status: { argv: ['auth', 'status'], matchJson: { identity: 'user' } },
    unauth: { argv: ['config', 'remove'] },
    skillsCandidates: [{ dir: path.join(STAGE, 'lark-tag', 'cli-1.0.100', 'skills'), origin: 'github:larksuite/cli@v1.0.100' }],
    skillsFetcher: async () => {
      const dir = path.join(STAGE, 'lark-tag');
      await fetchTgz('https://codeload.github.com/larksuite/cli/tar.gz/refs/tags/v1.0.100', 'lark-v10100.tgz', dir);
      return path.join(dir, 'cli-1.0.100', 'skills');
    },
    // npm tarball 无 skills/（仅 shim）→ 技能取官方 GitHub 仓库 tag v1.0.100，
    // MIT LICENSE 从同 tag 仓库根复制到每个技能目录。
    licenseCandidates: [
      path.join(STAGE, 'lark-tag', 'cli-1.0.100', 'LICENSE'),
      path.join(STAGE, 'feishu-pkg', 'package', 'LICENSE'),
    ],
    licenseFetcher: async () => {
      const dest = path.join(STAGE, 'feishu-LICENSE');
      await download('https://raw.githubusercontent.com/larksuite/cli/v1.0.100/LICENSE', dest);
      return dest;
    },
    provenance: {
      source: 'larksuite/cli 官方仓库 tag v1.0.100 skills/（npm 包仅 shim 无 skills，从 GitHub 提取）',
      url: 'https://github.com/larksuite/cli/tree/v1.0.100/skills',
      license: 'MIT',
    },
    readme: '## 飞书 CLI 连接器\n\n厂商官方 `@larksuite/cli`（lark-cli），扫码登录授权，覆盖即时通讯、邮箱、日历、云文档、电子表格、多维表格、幻灯片、画板、知识库、云空间、妙记、视频会议、任务、审批、考勤、通讯录、OKR 等全产品能力。\n\n### 连接方式\n\n1. 点击「连接」，GWork 自动准备 Node 运行时并安装官方 CLI；\n2. 首次使用先初始化配置（open.feishu.cn），随后展示飞书授权链接（accounts.feishu.cn），扫码/浏览器确认；\n3. 授权完成后自动连接。凭据由官方 CLI 自管，GWork 不接触 token。\n\n技能包来源：厂商官方 GitHub 仓库 v1.0.100（MIT，每个技能目录含 LICENSE）。',
  },
  {
    name: 'wecom',
    package: '@wecom/cli', version: '1.3.4',
    binName: 'wecom-cli', binPath: 'bin/wecom.js',
    // bin/wecom.js 是官方 node shim：解析 optionalDependencies 平台包
    // @wecom/cli-win32-x64/bin/wecom-cli.exe 并透传 argv/stdio。原生 exe 不在
    // 主包内（binPath 必须包内相对路径），故用 node 直跑 shim（已实测）。
    // {qr} 占位符由内核替换为临时 PNG 路径（--output-qrcode 实测存在）。
    auth: { argv: ['auth', 'init', '--noninteractive', '--no-browser', '--output-qrcode', '{qr}'], urlDomain: 'work.weixin.qq.com', waitForExit: true, qrPngArg: '--output-qrcode' },
    status: { argv: ['auth', 'show'], matchRegex: '\\bauthorized\\b' },
    // WB 的 unAuth 是 rmdir 配置目录（非官方 CLI 命令）→ 留空对象，内核仅清本地态。
    unauth: {},
    skillsCandidates: [{ dir: path.join(STAGE, 'wecom-repo', 'wecom-cli-main', 'skills'), origin: 'github:WeComTeam/wecom-cli@1.3.4' }],
    skillsFetcher: async () => {
      const dir = path.join(STAGE, 'wecom-repo');
      await fetchTgz('https://codeload.github.com/WeComTeam/wecom-cli/tar.gz/refs/heads/main', 'wecom-cli-repo.tgz', dir);
      return path.join(dir, 'wecom-cli-main', 'skills');
    },
    licenseCandidates: [path.join(STAGE, 'wecom-repo', 'wecom-cli-main', 'LICENSE')],
    licenseFetcher: async () => {
      const dest = path.join(STAGE, 'wecom-LICENSE');
      await download('https://raw.githubusercontent.com/WeComTeam/wecom-cli/main/LICENSE', dest);
      return dest;
    },
    provenance: {
      source: 'WeComTeam/wecom-cli 官方仓库 skills/（main 分支 package.json version=1.3.4 与 npm 精确对齐；WB 缓存 skills 无 LICENSE 不采用）',
      url: 'https://github.com/WeComTeam/wecom-cli/tree/main/skills',
      license: 'MIT',
    },
    readme: '## 企业微信 CLI 连接器\n\n厂商官方 `@wecom/cli`（wecom-cli），扫码登录授权，覆盖消息、邮件、文档、待办、日程、会议、微盘、通讯录等业务能力。\n\n### 连接方式\n\n1. 点击「连接」，GWork 自动准备 Node 运行时并安装官方 CLI；\n2. 弹窗展示企业微信授权二维码（PNG），手机企业微信扫码确认；\n3. 授权完成后自动连接。凭据由官方 CLI 自管，GWork 不接触 token。\n\n技能包来源：厂商官方 GitHub 仓库（MIT，每个技能目录含 LICENSE）。',
  },
  {
    name: 'tmeet',
    package: '@tencentcloud/tmeet', version: '1.1.0',
    binName: 'tmeet', binPath: 'scripts/tmeet.js',
    auth: { argv: ['auth', 'login', '--no-browser'], urlDomain: 'meeting.tencent.com', waitForExit: true },
    // 实测（2026-11-14，@tencentcloud/tmeet@1.1.0 win32）：auth status 输出纯文本
    // 而非 JSON——未登录 "Not logged in. Please use 'tmeet auth login' ..."，
    // 已登录首行 "Logged in"。故用 matchRegex（大小写敏感，\b 边界确保不匹配
    // "Not logged in" 的小写 logged in）。
    status: { argv: ['auth', 'status'], matchRegex: '\\bLogged in\\b' },
    unauth: { argv: ['auth', 'logout'] },
    skillsCandidates: [{ dir: path.join(WB, 'tmeet', 'skills'), origin: 'workbuddy-cache' }],
    skillsFetcher: null, // 厂商 npm 包 dist/scripts 均无 skills；WB 缓存是唯一公开原料
    // WB 缓存技能无 LICENSE → 补 npm 包 MIT LICENSE 全文（来源与许可在
    // plugin.json skills_provenance 注明）。
    licenseCandidates: [path.join(STAGE, 'tmeet-LICENSE'), path.join(TMEET_PROBE, 'LICENSE')],
    licenseFetcher: async () => {
      const dest = path.join(STAGE, 'tmeet-LICENSE');
      await download('https://raw.githubusercontent.com/TencentCloud/tencentmeeting-cli/main/LICENSE', dest);
      return dest;
    },
    provenance: {
      source: 'WB 公开仓库缓存 skills/tmeet-skill（厂商 npm 包无 skills）；LICENSE 补自 @tencentcloud/tmeet@1.1.0 npm 包根 LICENSE（MIT 全文）',
      url: 'https://www.npmjs.com/package/@tencentcloud/tmeet',
      license: 'MIT',
    },
    readme: '## 腾讯会议 CLI 连接器\n\n厂商官方 `@tencentcloud/tmeet`（tmeet），扫码登录授权，支持会议创建/查询/管理、录制与转写、会议报告、通讯录、会中控制、元宝纪要、实时事件订阅。\n\n### 连接方式\n\n1. 点击「连接」，GWork 自动准备 Node 运行时并安装官方 CLI；\n2. 弹窗展示腾讯会议授权链接，浏览器/扫码确认；\n3. 授权完成后自动连接。凭据由官方 CLI 自管，GWork 不接触 token。\n\n与「腾讯会议」Token MCP 条目并存：本条目走个人扫码授权，无需手填 Token。\n\n技能包来源：厂商官方技能（MIT，LICENSE 全文随技能目录分发）。',
  },
];

// ── 技能落盘（debrand + 每目录 LICENSE + 路径安全） ──────────────────────────
function skillFrontmatterName(skillMdPath) {
  try {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const n = m[1].match(/^name:\s*(.+)$/m);
    return n ? n[1].trim().replace(/^['"]|['"]$/g, '') : null;
  } catch { return null; }
}

function installSkills(spec, srcDir, licensePath) {
  const destRoot = path.join(OUT, spec.name, 'skills');
  fs.mkdirSync(destRoot, { recursive: true });
  const manifest = [];
  let fileCount = 0, byteCount = 0;
  for (const skillDir of fs.readdirSync(srcDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const from = path.join(srcDir, skillDir);
    const skillMd = path.join(from, 'SKILL.md');
    if (!exists(skillMd)) { warn(spec.name + '/' + skillDir + ' 无根部 SKILL.md，跳过'); continue; }
    const to = path.join(destRoot, skillDir);
    fs.mkdirSync(to, { recursive: true });
    for (const file of walkFiles(from)) {
      const rel = path.relative(from, file).split(path.sep).join('/');
      if (rel.split('/').some((s) => s === '..' || s === '' ) || path.isAbsolute(rel)) throw new Error('技能源路径不安全: ' + file);
      const dest = path.join(to, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (isTextFile(file)) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(dest, debrandSkillText(text));
      } else {
        fs.copyFileSync(file, dest);
      }
      fileCount++; byteCount += fs.statSync(dest).size;
    }
    // 每套技能目录必须含 LICENSE（Apache-2.0/MIT 全文）。源自带的不动；缺的补。
    if (!exists(path.join(to, 'LICENSE'))) {
      if (!licensePath) throw new Error(spec.name + '/' + skillDir + ' 缺 LICENSE 且无合规补全来源');
      fs.copyFileSync(licensePath, path.join(to, 'LICENSE'));
      fileCount++; byteCount += fs.statSync(licensePath).size;
    }
    const fmName = skillFrontmatterName(skillMd);
    if (fmName && fmName !== skillDir) warn(spec.name + '/' + skillDir + ' frontmatter name=' + fmName + ' 与目录名不一致（manifest 用目录名）');
    manifest.push({ name: skillDir, dir: 'skills/' + skillDir });
  }
  return { manifest, fileCount, byteCount };
}

async function resolveLicense(spec) {
  if (!spec.licenseCandidates) return null; // dingtalk：LICENSE 随技能目录自带
  for (const p of spec.licenseCandidates) if (exists(p)) {
    const staged = path.join(STAGE, spec.name + '-LICENSE');
    if (path.resolve(p) !== path.resolve(staged)) { fs.mkdirSync(STAGE, { recursive: true }); fs.copyFileSync(p, staged); }
    return staged;
  }
  if (spec.licenseFetcher) {
    try { return await spec.licenseFetcher(); } catch (e) { warn(spec.name + ' LICENSE 网络拉取失败: ' + e.message); }
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
// 真源优先级：已入库 plugin.json（含 display / cli_spec / skills 清单 /
// provenance / readme）> WB 本机缓存（可选刷新 display）> 内置 SPECS 兜底。
const WB_PLUGIN = (name) => {
  const p = path.join(WB, name, '.codebuddy-plugin', 'plugin.json');
  const j = readJson(p); // 本机无 WorkBuddy 安装时不 throw（可选刷新源）
  if (!j) return null;
  return (j.extensions && (j.extensions['ai.workbuddy'] || j.extensions['cn.gourd.gwork']));
};
function checkedInBase(name) {
  const p = path.join(OUT, name, '.gwork-plugin', 'plugin.json');
  const j = readJson(p);
  if (!j || !j.extensions || !j.extensions['cn.gourd.gwork']) return null;
  return { plugin: j, gw: j.extensions['cn.gourd.gwork'] };
}
// 基底 = 已入库 cli_spec（真源），内置 SPECS 仅补齐缺失字段/修复历史缺陷。
// 这样换机/清缓存后重跑与已入库真源逐字节一致，不会因脚本内置值漂移。
function normalizeSpec(base, generated) {
  const spec = (base && base.cli_spec && typeof base.cli_spec === 'object')
    ? JSON.parse(JSON.stringify(base.cli_spec)) : { ...generated };
  for (const [k, v] of Object.entries(generated)) if (spec[k] === undefined) spec[k] = v;
  // skipIf 必须是字符串数组（Rust CliAuthStep.skip_if: Option<Vec<String>>）。
  // 历史真源曾误写对象 {argv:[...]}，此处兜底规范化，杜绝重建带回 P0 缺陷。
  const fixSteps = (steps) => steps.map((st) => {
    if (!st || typeof st !== 'object' || st.skipIf === undefined) return st;
    const si = st.skipIf;
    const fixed = Array.isArray(si) ? si : (si && Array.isArray(si.argv) ? si.argv : null);
    if (!fixed || !fixed.every((a) => typeof a === 'string')) throw new Error('skipIf 必须是字符串数组（cli_spec Rust 契约）');
    return { ...st, skipIf: fixed };
  });
  if (Array.isArray(spec.authSteps)) spec.authSteps = fixSteps(spec.authSteps);
  if (spec.auth && spec.auth.skipIf !== undefined) spec.auth = fixSteps([spec.auth])[0];
  return spec;
}
fs.mkdirSync(STAGE, { recursive: true });
for (const spec of SPECS) {
  // P0：display 基底取已入库真源；本机 WB 缓存只作为可选刷新源（缺失不 throw）。
  // 已入库真源优先，保证换机/清缓存后逐字节幂等重建。
  const base = checkedInBase(spec.name);
  const wbExt = WB_PLUGIN(spec.name);
  const wbDisplay = wbExt && wbExt.display;
  const baseDisplay = base && base.gw.display;
  if (!baseDisplay && !wbDisplay) throw new Error(spec.name + ': 已入库 plugin.json 与 WB 缓存均无 display（原料不可用）');
  const raw = baseDisplay || wbDisplay;
  const display = {
    name: debrandDisplay(raw.name),
    name_en: debrandDisplay(raw.name_en),
    description_zh: debrandDisplay(raw.description_zh),
    description_en: debrandDisplay(raw.description_en),
  };

  // 技能真源必须先复制到 STAGE（resolveSkillsDir 内部），再 rmSync(outDir)；
  // 否则「先删后读」会把 4 条 CLI 的唯一真源一起删掉。
  const resolved = await resolveSkillsDir(spec.name, spec.skillsCandidates, spec.skillsFetcher);

  // CLI 形态：整目录重建（旧钉钉 stdio 的 mcp.json 一并清除）。
  const outDir = path.join(OUT, spec.name);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, '.gwork-plugin'), { recursive: true });

  let skills = [], skillStats = { fileCount: 0, byteCount: 0 };
  if (resolved) {
    // 已入库真源/暂存源已含合规 LICENSE 时完全不需要联网补许可；
    // 只有源里确缺 LICENSE 才解析补全来源（含可选网络拉取）。
    const needsLicense = fs.readdirSync(resolved.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .some((e) => !exists(path.join(resolved.dir, e.name, 'LICENSE')));
    const licensePath = needsLicense ? await resolveLicense(spec) : null;
    const r = installSkills(spec, resolved.dir, licensePath);
    skills = r.manifest; skillStats = r;
    if (!skills.length) warn(spec.name + ' 技能源存在但无有效技能目录');
  } else {
    warn(spec.name + ' 无合规技能来源，skills 置空（宁缺毋滥）');
  }

  const generatedSpec = {
    package: spec.package, version: spec.version, binName: spec.binName, binPath: spec.binPath,
  };
  if (spec.npmEnv) generatedSpec.npmEnv = spec.npmEnv;
  if (spec.authSteps) generatedSpec.authSteps = spec.authSteps; else generatedSpec.auth = spec.auth;
  generatedSpec.status = spec.status;
  generatedSpec.unauth = spec.unauth;
  const cli_spec = normalizeSpec(base && base.gw, generatedSpec);

  const gw = {
    schemaVersion: '1.0.0',
    kind: 'cli',
    tier: 'cli',
    auth: { authType: 'cli_login' },
    display,
    categories: ['communication'],
    source: 'vendor-cli:' + spec.package + '@' + spec.version,
    cli_spec,
    skills,
    skills_provenance: { ...spec.provenance, skillCount: skills.length, fileCount: skillStats.fileCount, byteCount: skillStats.byteCount },
    readme: spec.readme,
  };
  // 已入库真源里的展示/审计字段优先保留（顺序无关、逐字段可重跑）。
  if (base) {
    for (const k of ['schemaVersion', 'kind', 'tier', 'auth', 'categories', 'source', 'skills', 'skills_provenance', 'readme']) {
      if (base.gw[k] !== undefined) gw[k] = base.gw[k];
    }
  }
  // 技能以本轮真实落盘结果为准（清单来自源目录，不沿用陈旧清单）。
  gw.skills = skills;
  const plugin = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: spec.name,
    version: '1.0.0',
    description: display.description_en || display.description_zh,
    keywords: ['cli', 'skills'],
    extensions: { 'cn.gourd.gwork': gw },
  };
  fs.writeFileSync(path.join(outDir, '.gwork-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n');
  report.generated.push({ name: spec.name, skills: skills.length, files: skillStats.fileCount, bytes: skillStats.byteCount, skillsOrigin: resolved ? resolved.origin : 'none', displayOrigin: wbDisplay ? 'workbuddy-cache' : 'checked-in' });
  console.log('generated:', spec.name, 'skills=' + skills.length, 'files=' + skillStats.fileCount, 'bytes=' + skillStats.byteCount);
}

// ── featured-source.json 幂等同步：删除旧钉钉 stdio 条目 ─────────────────────
const featuredPath = path.join(ROOT, 'featured-source.json');
const featured = readJson(featuredPath);
if (!featured || !Array.isArray(featured.entries)) throw new Error('featured-source.json 缺失或损坏');
const before = featured.entries.length;
featured.entries = featured.entries.filter((e) => e.id !== 'featured:dingtalk');
if (featured.entries.length !== before) {
  fs.writeFileSync(featuredPath, JSON.stringify(featured, null, 2) + '\n');
  report.featuredRemoved = true;
  console.log('featured-source.json: 移除 featured:dingtalk（旧 stdio 形态，由 CLI 条目替换）');
} else {
  console.log('featured-source.json: 无旧钉钉条目（幂等）');
}
// 护栏：腾讯会议 token MCP 条目必须保留（tmeet 是独立新增，不是替换）。
if (!featured.entries.some((e) => e.id === 'featured:tencent-meeting')) throw new Error('featured:tencent-meeting 丢失——拒绝继续');

fs.writeFileSync(path.join(STAGE, 'import-cli-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log('cli connectors:', report.generated.length, 'warnings:', report.warnings.length);