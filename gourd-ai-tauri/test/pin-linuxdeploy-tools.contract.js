#!/usr/bin/env node
/* ============================================================
   cmd/pin-linuxdeploy-tools.js 的**进程级契约测试**（零依赖，跨平台）

   ── 为什么需要这一层，而不是只靠脚本内置的 --self-test ──
   --self-test 只能验证纯函数；而这个脚本最要命的契约全在**进程边界**上：
     · 打包路径上任何内部错误都必须降级为告警 + exit 0（绝不阻断 Linux job）
     · --plan / --self-test 是给人排查用的，必须响亮失败（exit 1）
     · 用法错误（拼错参数）必须 exit 2，不能被上面的降级逻辑吞掉
   这三条只有真的起子进程、看退出码才能证明。

   ── 事故背景（2026-09-07）──
   一个 `homedir = os.homedir()`（默认值带括号求值成字符串，调用点却当函数用）
   的 TypeError 把整条 Linux job 干红。它躲过两道防线：
     ① 本机是 Windows，resolveArch() 提前 return，那行代码从未执行；
     ② 单测里每个用例都显式注入 homedir 覆写，默认分支一次都没走到。
   于是有了下面两组针对性断言：
     · C 组把事故形态**原样注入回去**，证明它已不可能再阻断构建；
     · 所有需要「走到 Linux 分支」的场景都用 --platform/--arch 模拟，
       保证 Windows / macOS 的 runner 也能真实覆盖 Linux-only 代码。

   ── 环境隔离（血泪教训）──
   所有会走到下载分支的场景，一律用 XDG_CACHE_HOME 指向临时目录。
   否则模拟 Linux 时会把文件写进**真实用户**的 ~/.cache/tauri —— 本机第一次
   跑这个测试就差点这么干（当时靠证书校验失败才侥幸没写进去）。

   用法：
     node test/pin-linuxdeploy-tools.contract.js              离线跑全部（CI 用这个）
     node test/pin-linuxdeploy-tools.contract.js --network    额外验证钉住的 URL 真的可下载
   ============================================================ */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE_DIR = path.resolve(__dirname, '..');
const SRC = path.join(MODULE_DIR, 'cmd', 'pin-linuxdeploy-tools.js');

const WANT_NETWORK = process.argv.includes('--network') || process.env.PIN_TOOLS_NETWORK_CHECK === '1';

let passed = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log(String(detail).split('\n').map((l) => `         ${l}`).join('\n'));
  }
}

/** 起一个真实子进程跑脚本。env 默认隔离 XDG_CACHE_HOME，绝不污染真实用户缓存。 */
function run(args, { script = SRC, cwd = MODULE_DIR, env = {}, timeoutMs = 120000 } = {}) {
  const cacheDir = env.__CACHE_DIR__ || fs.mkdtempSync(path.join(os.tmpdir(), 'pin-contract-cache-'));
  const cleanEnv = { ...process.env, ...env, XDG_CACHE_HOME: cacheDir };
  delete cleanEnv.__CACHE_DIR__;
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', cwd, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, cacheDir };
}

/** 只取「URL 那一行」做断言。
 *  全输出里合法地含有 "continuous"（planFor 的 why 文案就在解释为什么要避开它），
 *  第一版测试对整份输出做 includes('continuous') 判定，于是自己把自己判 FAIL 了。 */
function urlLines(out) {
  return out.split('\n').filter((l) => l.includes('←') || /https?:\/\//.test(l));
}

/** 把脚本复制一份并做字符串替换，用来注入故障。替换没命中必须报错，否则测试是假的。 */
function makeMutant(sandbox, from, to, label) {
  const text = fs.readFileSync(SRC, 'utf8');
  if (!text.includes(from)) throw new Error(`注入锚点未命中（${label}）：${JSON.stringify(from)}`);
  const mutated = text.replace(from, to);
  if (mutated === text) throw new Error(`注入未生效（${label}）`);
  const dest = path.join(sandbox, `mutant-${label}.js`);
  fs.writeFileSync(dest, mutated, 'utf8');
  return dest;
}

function sandboxDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pin-contract-${prefix}-`));
}

/* ============================================================ */
console.log('=== A. 正常路径与内置自检 ===');
/* ============================================================ */
{
  const r = run(['--self-test']);
  assert('A1 --self-test 退出码 0', r.code === 0, `code=${r.code}\n${r.out.slice(-1500)}`);
  const m = r.out.match(/自检结束：(\d+) 通过，(\d+) 失败/);
  assert('A2 自检报告 0 失败', !!m && m[2] === '0', r.out.slice(-800));
  const count = m ? Number(m[1]) : 0;
  assert('A3 自检断言数不少于 20（防止被无意削减）', count >= 20, `实际 ${count}`);
  assert('A4 自检含「不注入 homedir」这条事故回归守卫', r.out.includes('不注入 homedir'), '缺回归守卫');
  console.log(`       (自检断言条数: ${count})`);
}
{
  const r = run(['--plan']);
  assert('A5 宿主非 Linux 时 --plan 退出 0 并明确跳过',
    r.code === 0 && r.out.includes('不需要 AppImage 工具'), `code=${r.code}\n${r.out}`);
}
{
  const r = run(['--plan', '--platform=linux', '--arch=x64']);
  assert('A6 模拟 linux/x64 的 --plan 退出 0（Linux 分支在 Windows/mac 上真实执行）',
    r.code === 0, `code=${r.code}\n${r.out}`);
  assert('A7 真的走到了工具目录解析', /工具目录: /.test(r.out), r.out);
  assert('A8 落盘文件名不带架构后缀（照抄 URL 会白钉）',
    r.out.includes('linuxdeploy-plugin-appimage.AppImage'), r.out);
  const urls = urlLines(r.out).join('\n');
  assert('A9 URL 带架构后缀', /linuxdeploy-plugin-appimage-x86_64\.AppImage/.test(urls), urls);
  assert('A10 URL 绝不出现滚动 tag continuous', !urls.includes('continuous'), urls);
  assert('A11 --plan 明确声明未联网未落盘', r.out.includes('未联网、未落盘'), r.out);
  assert('A12 --plan 未在任何地方落盘', fs.readdirSync(r.cacheDir).length === 0, fs.readdirSync(r.cacheDir).join());
}
{
  const r = run(['--plan', '--platform=linux', '--arch=arm64']);
  assert('A13 arm64 映射为 aarch64', r.code === 0 && urlLines(r.out).join().includes('-aarch64.AppImage'),
    `code=${r.code}\n${r.out}`);
}

/* ============================================================ */
console.log('\n=== B. 用法错误必须响亮失败（exit 2），不能被降级逻辑吞掉 ===');
/* ============================================================ */
for (const [args, label, needle] of [
  [['--oops'], 'B1 未知参数', '未知参数'],
  [['--platform'], 'B2 --platform 缺取值', '缺少取值'],
  [['--plan=yes'], 'B3 开关型参数带值', '不接受取值'],
]) {
  const r = run(args);
  assert(`${label} → exit 2`, r.code === 2, `code=${r.code}\n${r.out.slice(0, 400)}`);
  assert(`${label} 错误信息可读（含「${needle}」）`, r.out.includes(needle), r.out.slice(0, 400));
}

/* ============================================================ */
console.log('\n=== C. ★故障注入：脚本自身的问题绝不能再阻断打包★ ===');
/* ============================================================ */
const sandbox = sandboxDir('mutants');

/* C-1: 原事故形态已被 normalizeHomedir 彻底吃掉 */
{
  const mutant = makeMutant(sandbox, 'homedir = os.homedir }', 'homedir = os.homedir() }', 'homedir-bug');
  const r = run(['--plan', '--platform=linux', '--arch=x64'], { script: mutant, cwd: sandbox });
  assert('C1 复原 2026-09-07 事故形态（默认值带括号）后，--plan 仍 exit 0', r.code === 0,
    `code=${r.code}\n${r.out.slice(-900)}`);
  assert('C2 事故形态不再产生 TypeError', !r.out.includes('is not a function'), r.out.slice(-900));
  assert('C3 事故形态下工具目录仍解析正确（落在隔离的 XDG_CACHE_HOME 下）',
    r.out.includes(path.join(r.cacheDir, 'tauri')), r.out);
}

/* C-2: 一个真的会抛的内部错误 —— 打包路径必须降级 exit 0 */
{
  const mutant = makeMutant(sandbox,
    'if (opts.selfTest) return runSelfTest();',
    "throw new Error('INJECTED_INTERNAL_FAILURE'); if (opts.selfTest) return runSelfTest();",
    'internal-throw');
  const r = run(['--platform=linux', '--arch=x64'], { script: mutant, cwd: sandbox });
  assert('C4 打包路径遇内部错误 → exit 0（不阻断 Linux job）', r.code === 0, `code=${r.code}\n${r.out.slice(-900)}`);
  assert('C5 打出 ::warning:: 注解让 CI 显眼但不红', r.out.includes('::warning::[pin-tools] 内部错误'), r.out.slice(-900));
  assert('C6 告警说明退回 tauri 默认行为', r.out.includes('tauri 会自行下载 continuous'), r.out.slice(-900));
  assert('C7 保留原始错误信息供排查', r.out.includes('INJECTED_INTERNAL_FAILURE'), r.out.slice(-900));
  assert('C8 保留堆栈', /at\s+\w/.test(r.out), r.out.slice(-900));

  const rp = run(['--plan', '--platform=linux', '--arch=x64'], { script: mutant, cwd: sandbox });
  assert('C9 同样的错误在 --plan（strict）下 → exit 1 响亮失败', rp.code === 1, `code=${rp.code}`);
}

/* C-3: 下载失败（非内部 bug）也要降级，且不能留下半个文件 */
{
  // 指向本机 1 端口：必定 ECONNREFUSED，快速且完全离线，走的却是**真实的 download() 与 catch**
  const mutant = makeMutant(sandbox,
    'const data = await download(item.url);',
    "const data = await download('http://127.0.0.1:1/nope.AppImage');",
    'download-fail');
  const r = run(['--platform=linux', '--arch=x64'], { script: mutant, cwd: sandbox });
  assert('C10 下载失败 → exit 0（optional 降级）', r.code === 0, `code=${r.code}\n${r.out.slice(-900)}`);
  assert('C11 打出钉版失败告警', r.out.includes('::warning::[pin-tools] linuxdeploy-plugin-appimage 钉版失败'), r.out.slice(-900));
  assert('C12 统计行报告「降级 1 个」', /降级 1 个/.test(r.out), r.out.slice(-600));
  assert('C13 失败时不留下半个文件', fs.existsSync(path.join(r.cacheDir, 'tauri')) === false
    || fs.readdirSync(path.join(r.cacheDir, 'tauri')).length === 0, '工具目录里有残留');
}

/* ============================================================ */
console.log('\n=== D. 环境隔离与仓库无副作用 ===');
/* ============================================================ */
{
  // 真实用户的 ~/.cache/tauri 绝不能被这个测试创建或写入
  const realCache = path.join(os.homedir(), '.cache', 'tauri');
  const before = fs.existsSync(realCache) ? fs.readdirSync(realCache).sort().join('|') : '<absent>';
  const r = run(['--platform=linux', '--arch=x64'], { script: SRC, cwd: MODULE_DIR });
  const after = fs.existsSync(realCache) ? fs.readdirSync(realCache).sort().join('|') : '<absent>';
  assert('D1 未写入真实用户的 ~/.cache/tauri', before === after, `before=${before}\nafter=${after}`);
  assert('D2 真实打包路径 exit 0（离线环境下走降级）', r.code === 0, `code=${r.code}\n${r.out.slice(-600)}`);
}
{
  const r = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', cwd: path.resolve(MODULE_DIR, '..') });
  const lines = (r.stdout || '').split('\n').filter((l) => l.trim());
  const polluted = lines.filter((l) => /linuxdeploy-plugin-appimage|\.cache\/tauri|target\/\.tauri|pin-contract|mutant-/.test(l));
  assert('D3 测试未往仓库里落盘任何工具/临时文件', polluted.length === 0, polluted.join('\n'));
}

/* ============================================================ */
console.log(`\n=== E. 钉住的 URL 真实可达（${WANT_NETWORK ? '已启用' : '跳过，加 --network 开启'}） ===`);
/* ============================================================ */
if (WANT_NETWORK) {
  // 本机 Node 常缺中间 CA（表现为 unable to verify the first certificate）。
  // --use-system-ca 只在较新 Node 上存在，CI 的 Node 20 不认识 → 必须先探测再决定加不加。
  const probe = spawnSync(process.execPath, ['--use-system-ca', '-e', 'process.stdout.write("ok")'], { encoding: 'utf8' });
  const tlsArgs = (probe.status === 0 && (probe.stdout || '').includes('ok')) ? ['--use-system-ca'] : [];
  const inline = [
    `const m = require(${JSON.stringify(SRC)});`,
    `const url = m.planFor({ arch: 'x86_64', toolsDir: '/tmp/x' })[0].url;`,
    `m.download(url).then((b) => {`,
    `  process.stdout.write(JSON.stringify({ url, size: b.length, magic: b.subarray(0, 4).toString('hex') }));`,
    `}).catch((e) => { process.stdout.write(JSON.stringify({ url, error: String(e && e.message || e) })); });`,
  ].join('\n');
  const r = spawnSync(process.execPath, [...tlsArgs, '-e', inline], {
    encoding: 'utf8', cwd: MODULE_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000,
  });
  const raw = (r.stdout || '').trim();
  let info = null;
  try { info = JSON.parse(raw.slice(raw.indexOf('{'))); } catch (_) { /* 下面按失败处理 */ }
  assert('E1 钉住的 tag 资产可下载', !!info && !info.error, `stdout=${raw.slice(0, 600)}\nstderr=${(r.stderr || '').slice(0, 600)}`);
  if (info && !info.error) {
    console.log(`       ${info.url}\n       ${info.size} 字节, magic=${info.magic}`);
    assert('E2 下载内容是 ELF（不是错误页）', info.magic === '7f454c46', `magic=${info.magic}`);
    assert('E3 体积合理（>1MB）', info.size > 1024 * 1024, `${info.size} 字节`);
  }
}

/* ============================================================ */
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n=== 汇总：${passed} 通过，${failures.length} 失败 ===`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('契约测试全部通过');
process.exit(0);
