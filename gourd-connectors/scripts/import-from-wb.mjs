// import-from-wb.mjs — 从 WorkBuddy 公开连接器仓库导入 GWork 官方目录。
// 输入: .import-src/connectors/*（公开 zip 解包）+ probe-results.json + probe-sse-results.json
// 输出: connectors/<name>/{mcp.json, .gwork-plugin/plugin.json}
// 规则见 README「收录原则」。可重跑：重建 MCP 条目时保留并原样恢复全部 CLI
//   目录（动态发现，2026-11 起 28 条）与 3 条 featured 自营条目（重建前快照到
//   系统临时目录，重建后校验）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.import-src', 'connectors');
const OUT = path.join(ROOT, 'connectors');
const FEATURED_SRC = path.join(ROOT, 'featured-source.json');
// 预检：导入原料缺失时必须在 rmSync(OUT) 之前终止，绝不先删 CLI 再报错。
for (const p of [SRC, path.join(ROOT, '.import-src', 'probe-results.json'), path.join(ROOT, '.import-src', 'probe-sse-results.json'), FEATURED_SRC]) {
  if (!fs.existsSync(p)) {
    console.error('FATAL: 导入原料缺失 ' + p + ' —— 拒绝清空 connectors/（防止全部 CLI 丢失）');
    process.exit(1);
  }
}
const probe = JSON.parse(fs.readFileSync(path.join(ROOT, '.import-src', 'probe-results.json'), 'utf8'));
const sse = JSON.parse(fs.readFileSync(path.join(ROOT, '.import-src', 'probe-sse-results.json'), 'utf8'));

// ── 分类映射（人工编排；key 必须 ∈ 内核 market::categories()） ──────────────
const CATEGORY_BY_NAME = {
  // 笔记 / 文档 / 知识管理
  'kdocs': 'note-taking', 'lexiang': 'knowledge-and-memory', 'getnote': 'note-taking',
  'wisenote': 'note-taking', 'lawaken-memory': 'knowledge-and-memory', 'xmind': 'note-taking',
  'wavenote-audio': 'note-taking', 'viaim': 'note-taking', 'beluga-mcp-prod': 'knowledge-and-memory',
  'verya-knowledgebase': 'knowledge-and-memory', 'tencent-weiyun': 'file-systems',
  // 开发 / 版本控制 / 云
  'github': 'version-control', 'cnb-api': 'version-control', 'gitlab-docs-mcp': 'developer-tools',
  'cloudbase': 'cloud-platforms', 'tencent-dlc': 'cloud-platforms', 'tencent-tchouse-c': 'databases',
  'adc-approval': 'cloud-platforms', 'adc-sandbox': 'cloud-platforms', 'lxcloud': 'cloud-platforms',
  'gt-generate-sql-data': 'databases', 'h3c-cloudnet': 'cloud-platforms',
  // 交流协作
  'qq-mail': 'communication', 'tapd': 'developer-tools', 'ezjoin-meeting': 'communication',
  'lingxi': 'communication', 'tencent-qidian-cs': 'communication', 'weiban-agent-mcp': 'communication',
  'yixiaoke': 'communication', 'neo-crm': 'communication', 'sharecrm': 'communication',
  'leads-cloud-crm': 'communication', 'salestouch': 'communication', 'fenbeitong': 'communication',
  'huilianyi': 'communication', 'smartsalary': 'communication', 'erhao-hr': 'communication',
  '51shebao-hr-tools': 'communication', 'moka': 'communication', 'jumper-kpi': 'communication',
  'beisen-cli': 'communication', 'tanyuan-assistant': 'communication', 'vox-teacher': 'communication',
  'teacher-assistant': 'communication', 'aiclass-teaching': 'communication', 'edu-next': 'communication',
  'yunzhi-campus': 'communication', 'yunzhi-mcp': 'communication', 'meo-xiaoyuan': 'communication',
  // 金融 / 研究数据
  'efunds': 'finance', 'neodata': 'finance', 'westock-mcp': 'finance', 'tdx-connector': 'finance',
  'wind-finance': 'finance', 'mx-ds-mcp': 'finance', 'datayes-data': 'finance', 'dzh-mcp': 'finance',
  'gfsecurities': 'finance', 'morningstar': 'finance', 'pandadata': 'finance', 'sumscope-data': 'finance',
  'tongzhou-fin-research': 'finance', 'xuan-gu-mo-fang': 'finance', 'niuguwang-sim-trading': 'finance',
  'yingmi-mcp': 'finance', 'orientfutures-mobile-knowledge-base': 'finance', 'mergerinfo': 'finance',
  'reportgem-research': 'finance', 'finenter': 'finance', 'investoday-finance-data': 'finance',
  'fiu-mcp-server': 'finance', 'amazingdata-mcp': 'finance', 'wscnmcp-token': 'finance',
  'alphapai-lite-mcp': 'finance', 'qibook-mcp': 'finance', 'yiqi-query': 'entertainment-and-media',
  // 企业数据 / 法律
  'qcc-company': 'research-and-data', 'qcc-legal': 'research-and-data', 'tyc-mcp': 'research-and-data',
  'pkulaw': 'research-and-data', 'fyopen-lawsearch': 'research-and-data', 'yuandian-mcp': 'research-and-data',
  'wk-workbuddy': 'research-and-data', 'xiaolv-law-search': 'research-and-data', 'lawyerone': 'research-and-data',
  'mindbye-contract-review': 'research-and-data', 'kuaicha-search': 'research-and-data',
  'qixinhuiyan-mcp': 'research-and-data', 'dnb-global-data': 'research-and-data',
  'dnb-longyicha-workbuddy': 'research-and-data', 'shuidi-credit': 'research-and-data',
  'shuidi-discovery': 'research-and-data', 'primematrix-company': 'research-and-data',
  'sdc-enterprise-info': 'research-and-data', 'cisp-mcp': 'research-and-data',
  'xingtu-claw-risk': 'research-and-data', 'youshu-bd-mate': 'research-and-data',
  'wanfang-literature-search-download-oauth': 'research-and-data', 'paper-retrieval': 'research-and-data',
  'xmed-figure-mcp': 'research-and-data', 'medlive-medical-qa': 'research-and-data',
  'medgroup-drgdip-toolkit': 'research-and-data', 'archive-hospital-mcp': 'research-and-data',
  'tencent-health-nges': 'research-and-data', 'tencent-yaoxiang-bi': 'research-and-data',
  // 图像 / 视频 / 设计
  'canva': 'image-and-video-processing', '58pic-qiantu-ai': 'image-and-video-processing',
  'kling-ai-plugin': 'image-and-video-processing', 'yiketu-ai': 'image-and-video-processing',
  'picset-commerce-images': 'image-and-video-processing', 'hanyi-fonts': 'image-and-video-processing',
  'rabbitvis': 'image-and-video-processing', 'chuangkit': 'image-and-video-processing',
  'today-watermark-camera': 'image-and-video-processing', 'bizmuse-ai-music-video': 'image-and-video-processing',
  'atlas-cloud': 'image-and-video-processing', 'ai-hive': 'image-and-video-processing',
  'jihua-ai-studio': 'image-and-video-processing', 'novai-studio': 'image-and-video-processing',
  'yihook': 'image-and-video-processing', 'creatok': 'image-and-video-processing',
  'camscanner-mcp': 'image-and-video-processing', 'cue-parser': 'developer-tools',
  'textin-xparse': 'image-and-video-processing',
  // 电商 / 跨境
  'lingxing-mcp': 'research-and-data', 'fastmoss': 'research-and-data', 'chuhaijiang': 'research-and-data',
  'proboost': 'research-and-data', 'zhenghe-data-tk-assistant': 'research-and-data',
  'linkfox': 'research-and-data', 'menglar-ozon': 'research-and-data', 'kiwi-merchant': 'research-and-data',
  'eccang-reconcile': 'research-and-data', 'listinggood': 'research-and-data',
  'infimind-ecommerce-content': 'research-and-data', 'sparkx-ai-mcp': 'research-and-data',
  'tec-do': 'research-and-data', 'yichayun-trade-data': 'research-and-data',
  'zxygj-business-data': 'research-and-data', 'tm-bmis': 'research-and-data',
  'cloudmall-operations': 'research-and-data', 'car-saas': 'research-and-data',
  'property-saas': 'research-and-data', '77ircloud': 'research-and-data',
  // 搜索 / 地图 / 生活
  'baidu-maps': 'location-services', 'tencent-map': 'location-services',
  'chainlon-geo-mcp': 'location-services', 'opendata': 'location-services',
  'variflight-mcp': 'location-services', 'oneaix-sea-rate-connector': 'location-services',
  'hefei-city-alerts': 'location-services', 'uupt': 'location-services',
  'jiushuyun': 'research-and-data', 'jinshuju': 'research-and-data', 'qingflow': 'developer-tools',
  'h3yun-connector': 'developer-tools', 'jiandaoyun': 'developer-tools',
  // 搜索
  'baixiao-mcp': 'search', '24haowan': 'entertainment-and-media', '24haowan-space': 'entertainment-and-media',
  'joyread-english': 'entertainment-and-media', 'dramabuddy': 'entertainment-and-media',
  'xuanpian-schedule': 'entertainment-and-media', 'opcmenu': 'entertainment-and-media',
  'wm-weight-manage': 'entertainment-and-media', 'plaud': 'note-taking',
};
const DEFAULT_CATEGORY = 'other';

// 渠道归因参数：一律剥离，不冒用他家渠道身份
const STRIP_QUERY_KEYS = new Set(['invite', 'channel', 'from', 'utm_source', 'utm_medium', 'utm_campaign', 'mcp_source']);

// 人工覆盖：name → 强制 tier / 排除 / auth 特例
const OVERRIDES = {
  // WB 专属托管域（*.workbuddy.link / *.woa.com 内网）不收录
  'charge-order-query': { exclude: 'wb-hosted-domain' },
  'knot': { exclude: 'wb-internal-domain' },
  // 腾讯文档个人版：用 GWork 已验证的真扫码（featured 迁移时处理，这里跳过避免重复）
  'tencent-docs': { exclude: 'superseded-by-qrcode-poll' },
  // 企业 OneID 专用（需 iOA 企业身份），个人用户连不上
  'tencent-docs-oa': { exclude: 'enterprise-oneid-only' },
  'ioa': { exclude: 'enterprise-only' },
  // 腾讯系自营：WB 走自家云代理，但厂商 OAuth 是公开标准形态（腾讯文档个人版
  // 连 WB 自己都是 mcp-oauth 本地直连）。保留并实测，DCR 可用即真能连。
  'github': { keep: true }, // GitHub OAuth App 支持 DCR 语义待实测，先保留
  // WB 的连接器开发工具（产出 WorkBuddy 规范 zip），与 GWork 目录无关，不收录
  'connector-workshop': { exclude: 'wb-devtool-not-a-connector' },
};

// 品牌清洗：上游描述里的宿主产品名换成 GWork。端点 URL 里的 workbuddy 路径段
// 是厂商侧渠道命名（实测可连），不改 URL 以免破坏连通性；描述文案不得替他家
// 产品打广告。只动展示文本（description / locales），不动 id/name/url。
function debrand(text) {
  return String(text || '').replace(/WorkBuddy/gi, 'GWork');
}

function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (STRIP_QUERY_KEYS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return raw; }
}

function stdType(t, url) {
  const s = String(t || '').toLowerCase();
  if (s === 'sse') return 'sse';
  if (s.includes('streamable') || s === 'http') return 'streamable_http';
  if (!s && url) return /\/sse($|\?)/i.test(url) ? 'sse' : 'streamable_http';
  return s || 'streamable_http';
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
// connectors/<dir>/ 全量指纹（路径 + SHA256），用于「原样恢复」的字节级校验。
function fingerprint(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[rel] = sha256File(p);
      else throw new Error('不支持的条目类型: ' + p);
    }
  };
  walk(dir);
  return out;
}
function countFiles(fp) { return Object.keys(fp).length; }

// WB 的 auth.mode=server-side 表示授权由 WorkBuddy 云端代理托管（厂商 OAuth
// client 注册在腾讯后端）。这些端点即使 401+元数据可发现，本地 DCR 也大概率
// 被拒——不收录，宁缺毋滥（P1 自建云端代理后再回补）。
const WB_CLOUD_ONLY = new Set(probe.results.filter(p => p.authMode === 'server-side').map(p => p.name));

// 第二层实测：RFC7591 动态客户端注册（DCR）是否开放。oauth 级条目只有
// dcr-open 才收录——我们的 oauth.rs 走 DCR，注册被拒的条目点了连接也走不通。
// 重跑顺序：probe-connectors → probe-sse → import(首轮) → probe-dcr → import(定稿)。
const dcrPath = path.join(ROOT, '.import-src', 'dcr-results.json');
const dcr = fs.existsSync(dcrPath) ? JSON.parse(fs.readFileSync(dcrPath, 'utf8')) : null;
const DCR_OPEN = dcr ? new Set(dcr.results.filter(r => r.verdict === 'dcr-open').map(r => r.name)) : null;

// 合并 SSE 复核结果（按 name+url 覆盖首轮判定）
const sseByName = new Map();
for (const r of sse.results) {
  if (!sseByName.has(r.name)) sseByName.set(r.name, []);
  sseByName.get(r.name).push(r);
}

// ── P0 幂等护栏 ─────────────────────────────────────────────────────────────
// 旧实现无条件 rmSync(OUT) 会静默删掉全部 CLI 目录（2026-11 起为 28 条：
// 钉钉/飞书/企微/腾讯会议 + 从 WB 公开仓库导入的 24 条）与 3 条 featured
// 自营目录。这里在清空前把它们快照到系统临时目录，重建后原样恢复并逐文件
// SHA256 校验；缺一即 FATAL exit(1)。
// CLI 目录**动态发现**（读 plugin.json 的 kind:"cli"），不再硬编码 4 条名单：
// 新增 CLI 连接器只需落 connectors/<id>/ 目录，本脚本自动纳入保护/恢复。
const CLI_NAMES = fs.readdirSync(OUT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => {
    const j = readJson(path.join(OUT, d.name, '.gwork-plugin', 'plugin.json'));
    return !!(j && j.extensions && j.extensions['cn.gourd.gwork'] && j.extensions['cn.gourd.gwork'].kind === 'cli');
  })
  .map((d) => d.name)
  .sort();
if (!CLI_NAMES.length) {
  console.error('FATAL: connectors/ 下未发现任何 cli 形态目录 —— 拒绝清空（数据真源疑似丢失）');
  process.exit(1);
}
const FEATURED_EXPECTED = ['featured:tencent-docs', 'featured:tencent-meeting', 'featured:tapd'];
const featuredNow = readJson(FEATURED_SRC);
if (!featuredNow || !Array.isArray(featuredNow.entries) || !featuredNow.entries.length) {
  console.error('FATAL: featured-source.json 缺失或为空 —— 拒绝清空 connectors/');
  process.exit(1);
}
const FEATURED_DIRS = featuredNow.entries
  .filter((e) => FEATURED_EXPECTED.includes(e.id))
  .map((e) => String(e.id).replace(/^featured:/, ''));
for (const id of FEATURED_EXPECTED) {
  if (!featuredNow.entries.some((e) => e.id === id)) {
    console.error('FATAL: featured-source.json 缺 ' + id + ' —— 拒绝继续');
    process.exit(1);
  }
}

// 快照：全部 CLI 目录（28 条）+ 3 条 featured 目录 + featured-source.json 原文。
const SNAP = fs.mkdtempSync(path.join(os.tmpdir(), 'gwork-import-wb-'));
const snapCliFp = {}, snapFeaturedFp = {};
let snapFeaturedBuf;
try {
  for (const name of CLI_NAMES) {
    const dir = path.join(OUT, name);
    if (!fs.existsSync(path.join(dir, '.gwork-plugin', 'plugin.json'))) {
      throw new Error('CLI 真源缺失: connectors/' + name + '/.gwork-plugin/plugin.json');
    }
    const fp = fingerprint(dir);
    if (!countFiles(fp)) throw new Error('CLI 真源为空: connectors/' + name);
    snapCliFp[name] = fp;
    fs.cpSync(dir, path.join(SNAP, 'cli', name), { recursive: true });
  }
  snapFeaturedBuf = fs.readFileSync(FEATURED_SRC);
  fs.writeFileSync(path.join(SNAP, 'featured-source.json'), snapFeaturedBuf);
  for (const short of FEATURED_DIRS) {
    const dir = path.join(OUT, short);
    if (!fs.existsSync(dir)) throw new Error('featured 目录缺失: connectors/' + short);
    snapFeaturedFp[short] = fingerprint(dir);
    fs.cpSync(dir, path.join(SNAP, 'featured', short), { recursive: true });
  }
} catch (e) {
  console.error('FATAL: 重建前快照失败（未触碰 connectors/）: ' + e.message);
  process.exit(1);
}
console.log('snapshot before rebuild:', CLI_NAMES.length + ' cli dirs,', FEATURED_DIRS.length + ' featured dirs →', SNAP);

const report = { imported: [], excluded: [], preserved: { cli: CLI_NAMES, featured: FEATURED_EXPECTED } };
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 重建后原样恢复（在任何写入逻辑之前，避免同名 MCP 条目覆盖 featured 目录）。
function restore() {
  const problems = [];
  for (const name of CLI_NAMES) {
    const dest = path.join(OUT, name);
    fs.cpSync(path.join(SNAP, 'cli', name), dest, { recursive: true, force: true });
    const fp = fingerprint(dest);
    const want = snapCliFp[name], got = fp;
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const k of keys) if (want[k] !== got[k]) problems.push('cli ' + name + ' 文件不一致: ' + k);
  }
  fs.writeFileSync(FEATURED_SRC, snapFeaturedBuf);
  for (const short of FEATURED_DIRS) {
    const dest = path.join(OUT, short);
    fs.rmSync(dest, { recursive: true, force: true }); // 去掉本轮 MCP 重建可能生成的同名目录
    fs.cpSync(path.join(SNAP, 'featured', short), dest, { recursive: true, force: true });
    const want = snapFeaturedFp[short], got = fingerprint(dest);
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const k of keys) if (want[k] !== got[k]) problems.push('featured ' + short + ' 文件不一致: ' + k);
  }
  // 校验「28 条 cli + 3 条 featured 齐全」，缺一即报错，禁止静默跳过。
  for (const name of CLI_NAMES) {
    const p = path.join(OUT, name, '.gwork-plugin', 'plugin.json');
    const j = readJson(p);
    if (!j || !j.extensions || !j.extensions['cn.gourd.gwork'] || j.extensions['cn.gourd.gwork'].kind !== 'cli' || !j.extensions['cn.gourd.gwork'].cli_spec) {
      problems.push('cli 条目缺失或形态错误: ' + name);
    }
  }
  const cliCount = fs.readdirSync(OUT, { withFileTypes: true }).filter((d) => {
    if (!d.isDirectory()) return false;
    const j = readJson(path.join(OUT, d.name, '.gwork-plugin', 'plugin.json'));
    return !!(j && j.extensions && j.extensions['cn.gourd.gwork'] && j.extensions['cn.gourd.gwork'].kind === 'cli');
  }).length;
  if (cliCount !== CLI_NAMES.length) problems.push('cli 条数=' + cliCount + '（应为 ' + CLI_NAMES.length + '）');
  const feat = readJson(FEATURED_SRC);
  const featCount = feat && Array.isArray(feat.entries) ? feat.entries.filter((e) => FEATURED_EXPECTED.includes(e.id)).length : 0;
  if (featCount !== 3) problems.push('featured 条数=' + featCount + '（应为 3）');
  for (const e of (feat && feat.entries) || []) {
    const short = String(e.id || '').replace(/^featured:/, '');
    if (!short || !FEATURED_EXPECTED.includes(e.id)) continue;
    const j = readJson(path.join(OUT, short, '.gwork-plugin', 'plugin.json'));
    if (!j || !j.extensions || !j.extensions['cn.gourd.gwork'] || j.extensions['cn.gourd.gwork'].tier !== 'verified') {
      problems.push('featured 目录形态错误: ' + short);
    }
  }
  if (problems.length) {
    for (const m of problems) console.error('FATAL:', m);
    console.error('FATAL: ' + CLI_NAMES.length + ' 条 cli / 3 条 featured 恢复校验失败，快照保留于 ' + SNAP);
    process.exit(1);
  }
  console.log('restored + verified: ' + CLI_NAMES.length + ' cli dirs, 3 featured dirs, 3 featured-source entries');
  fs.rmSync(SNAP, { recursive: true, force: true });
}
// restore() 用 finally 包裹整个重建段：中途任何异常/中断都必须把 CLI +
// featured 目录恢复回去（rmSync 已清空 OUT，跳过 restore 会静默丢数据）。
// 注意：中间分支里的 process.exit(1) 不触发 finally，故统一改为抛错，
// 由顶层 catch 打印后以非零码退出（finally 仍会执行）。
try {
for (const p of probe.results) {
  const name = p.name;
  const ov = OVERRIDES[name] || {};
  if (ov.exclude) { report.excluded.push({ name, reason: ov.exclude }); continue; }
  if (WB_CLOUD_ONLY.has(name) && !ov.keep) { report.excluded.push({ name, reason: 'wb-cloud-auth-only' }); continue; }
  if (p.verdict === 'non-http' || p.verdict === 'stdio') { report.excluded.push({ name, reason: 'cli-or-stdio' }); continue; }

  const srcDir = path.join(SRC, name);
  const mcp = readJson(path.join(srcDir, 'mcp.json'));
  if (!mcp || !mcp.mcpServers) { report.excluded.push({ name, reason: 'no-mcp-json' }); continue; }

  // 逐 server 合并复核，决定最终 tier
  const servers = {};
  let tiers = [];
  let probedAt = probe.probedAt;
  for (const s of p.servers) {
    if (!s.url) continue;
    let verdict = s.verdict, status = s.status, oauth = s.oauth;
    const re = (sseByName.get(name) || []).find(x => x.url === s.url);
    if (re) { verdict = re.verdict; status = re.status; oauth = re.oauth || oauth; }
    if (verdict !== 'open' && verdict !== 'oauth') continue; // 只收录实测可连的 server
    const url = cleanUrl(s.url);
    const cfg = { type: stdType(s.type, url), url };
    if (verdict === 'oauth') {
      cfg.auth = { authType: 'oauth', tokenLabel: (p.display && (p.display.name || p.display.name_en)) || name };
    }
    servers[name] = cfg;
    tiers.push(verdict);
  }
  if (!Object.keys(servers).length) { report.excluded.push({ name, reason: 'no-usable-server(' + p.verdict + ')' }); continue; }
  const tier = tiers.includes('open') ? 'open' : 'oauth';
  // oauth 级必须 DCR 实测开放（第二层探测结果存在时强制）
  if (tier === 'oauth' && DCR_OPEN && !DCR_OPEN.has(name)) {
    report.excluded.push({ name, reason: 'dcr-not-open' }); continue;
  }

  const d = p.display || {};
  const descZh = debrand(d.description_zh || d.description_en || '');
  const descEn = debrand(d.description_en || d.description_zh || '');
  const nameZh = d.name || d.name_en || name;
  const nameEn = d.name_en || d.name || name;
  const category = CATEGORY_BY_NAME[name] || DEFAULT_CATEGORY;

  const outDir = path.join(OUT, name);
  fs.mkdirSync(path.join(outDir, '.gwork-plugin'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'mcp.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: servers,
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, '.gwork-plugin', 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name,
    version: '1.0.0',
    description: descEn || descZh,
    keywords: ['mcp'],
    extensions: {
      'cn.gourd.gwork': {
        schemaVersion: '1.0.0',
        auth: tier === 'oauth' ? { authType: 'oauth' } : { authType: 'none' },
        display: { name: nameZh, name_en: nameEn, description_zh: descZh, description_en: descEn },
        categories: [category],
        tier,
        source: 'imported:workbuddy-connector-plugins-official',
        probedAt,
      },
    },
  }, null, 2) + '\n');
  report.imported.push({ name, tier, category });
}

// ── GWork 自营条目（真扫码/静态 token/stdio 形态保留） ──────────────────────
// 数据真源 = 仓库内 featured-source.json（入库）。历史教训：曾读内核
// featured.json，该文件在官方仓库轮被删除后重跑导入会**静默丢掉全部自营
// 条目**（177→172 事故）。真源必须与脚本同仓入库，且缺失时大声报错。
// 本轮顺序：先由脚本按真源重新落盘，末尾 restore() 再用重建前快照逐文件校验
// 字节一致（若被 MCP 重建覆盖，则以快照原样恢复，保证幂等）。
const featuredPath = FEATURED_SRC;
const featured = readJson(featuredPath);
if (!featured || !Array.isArray(featured.entries) || !featured.entries.length) {
  console.error('FATAL: featured-source.json 缺失或为空 —— 自营条目（腾讯文档扫码等）会全部丢失，拒绝继续');
  process.exit(1);
}
{
  for (const e of featured.entries) {
    const short = String(e.id || '').replace(/^featured:/, '');
    if (!short) continue;
    const cfg = e.server_config && e.server_config[0] && e.server_config[0].mcpServers;
    if (!cfg) continue;
    const outDir = path.join(OUT, short);
    fs.mkdirSync(path.join(outDir, '.gwork-plugin'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'mcp.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: cfg,
    }, null, 2) + '\n');
    const authDecl = (Object.values(cfg)[0] || {}).auth || { authType: 'none' };
    const plugin = {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: short,
      version: '1.0.0',
      description: (e.locales && e.locales.en && e.locales.en.description) || e.description || '',
      keywords: ['mcp'],
      extensions: {
        'cn.gourd.gwork': {
          schemaVersion: '1.0.0',
          auth: authDecl,
          display: {
            name: e.chinese_name || e.name, name_en: e.name,
            description_zh: (e.locales && e.locales.zh && e.locales.zh.description) || e.description || '',
            description_en: (e.locales && e.locales.en && e.locales.en.description) || e.description || '',
          },
          categories: e.categories || ['other'],
          tier: 'verified',
          source: 'gwork-featured',
          readme: e.readme || '',
          env_schema: e.env_schema || undefined,
        },
      },
    };
    fs.writeFileSync(path.join(outDir, '.gwork-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n');
    report.imported.push({ name: short, tier: 'verified', category: (e.categories || ['other'])[0] });
  }
}

fs.writeFileSync(path.join(ROOT, '.import-src', 'import-report.json'), JSON.stringify(report, null, 2));
const byTier = {};
for (const r of report.imported) byTier[r.tier] = (byTier[r.tier] || 0) + 1;
console.log('imported:', report.imported.length, JSON.stringify(byTier));
console.log('excluded:', report.excluded.length);
const byReason = {};
for (const r of report.excluded) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
console.log(JSON.stringify(byReason, null, 1));
} catch (e) {
  console.error('FATAL: 目录重建异常，正在恢复 CLI/featured 快照:', e && e.message ? e.message : e);
  throw e;
} finally {
  // 所有落盘完成后才恢复并校验全部 CLI + 3 条 featured，缺一即 FATAL exit(1)。
  restore();
}