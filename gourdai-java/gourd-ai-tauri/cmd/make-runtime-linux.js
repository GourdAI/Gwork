#!/usr/bin/env node
'use strict';

/**
 * make-runtime-linux.js —— 产出远端运行时资产 runtime-linux-<arch>.tar.gz（离线/内网改造一期 L1）。
 *
 * ## 背景
 * 远端（内网/CentOS/无 curl 机器）无可用 Java 时，桌面端把**内置的 jlink 精简运行时**
 * 经 SSH 上传部署（Rust 侧 bundled_runtime_asset → deploy_runtime）。资产形态：
 *   runtime-linux-x64.tar.gz      flat 布局（bin/ lib/ release/ gwork-runtime.json 在顶层）
 *   runtime-linux-aarch64.tar.gz  同上（可选产出）
 * 远端解包到 ~/.gwork/remote/runtime/<指纹>/ 并切 current 软链。
 *
 * ## 为什么是 jlink 自产而不是 Temurin 整包 JRE
 * - 体积：同模块清单 jlink 产物 gz ≈ 20MB，Temurin JRE gz ≈ 44.5MB（安装包代价减半）；
 * - 模块矩阵与桌面端内置 JRE 完全一致（桌面天天在跑 = 自带回归验证）；
 * - glibc 下限由 jmods 来源决定（取 Temurin jmods 即 ≥2.17，CentOS 7 可跑）。
 *
 * ## 跨架构原理
 * jlink 可在任意宿主对任意目标 jmods 链接（CI 的 mac 腿双架构已用同款手法）。
 * 本脚本：本地 jlink（JAVA_HOME 或常见路径）+ 目标架构的 **Linux JDK jmods**
 * （--jdk-x64/--jdk-arm64 指定已解包目录；缺省自动下载 Temurin JDK 17 到 .cache 复用）。
 *
 * ## 用法
 *   node cmd/make-runtime-linux.js                     # 只出 x64（下载 jmods 到 .cache）
 *   node cmd/make-runtime-linux.js --arch x64,arm64    # 双架构
 *   node cmd/make-runtime-linux.js --jdk-x64 "$JAVA_HOME"   # CI linux 腿：复用现成 JDK
 *   node cmd/make-runtime-linux.js --out <dir>         # 缺省 build/extraResources/runtimes
 *
 * 产物：runtime-linux-<arch>.tar.gz + 同名 .sha256 旁车（CI 上传/用户校验用）。
 * tar：Windows 钉死 System32 bsdtar（见 resolveTar），POSIX 用系统 tar。
 * Windows 宿主产出的条目可能丢可执行位——远端部署脚本解包后有 chmod +x bin/* 兜底。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(ROOT, 'build', 'extraResources', 'runtimes');
const CACHE = path.join(ROOT, '.cache', 'jdk-linux');

// 与 cmd/sync-backend.js 的 JLINK_MODULES、两条 workflow 的 MODULES 完全一致。
// 少一个模块的典型症状是远端运行期才抛 ClassNotFoundException。
const JLINK_MODULES = [
  'java.base',
  'java.logging',
  'java.sql',
  'java.naming',
  'java.management',
  'java.instrument',
  'java.net.http',
  'jdk.crypto.ec',
  'jdk.zipfs',
  'jdk.unsupported',
];

const MIN_MAJOR = 17;

function fail(msg) {
  console.error('[make-runtime-linux] 错误: ' + msg);
  process.exit(1);
}
function log(msg) {
  console.log('[make-runtime-linux] ' + msg);
}
function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── 本地 jlink（宿主 JDK） ───────────────────────────────────────────────────

function readJdkMajor(home) {
  try {
    const m = fs.readFileSync(path.join(home, 'release'), 'utf8').match(/JAVA_VERSION="?(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch (e) { /* 无 release 视为不可用 */ }
  return 0;
}

/**
 * 宿主 jlink 必须与目标 jmods **同主版本**（jlink 硬约束：版本不匹配直接报
 * 「jlink version X 与目标 java.base 版本 Y 不匹配」）。开发机常见 JDK 21/25，
 * 故先找 ==17 的宿主 JDK；找不到则下载宿主平台 Temurin JDK 17 到 .cache 复用。
 */
function findHostJlink() {
  const exe = process.platform === 'win32' ? 'jlink.exe' : 'jlink';
  const bases = process.platform === 'win32'
    ? ['C:\\Apps\\Java', 'D:\\Apps\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java']
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
  const homes = [process.env.JAVA_HOME, ...bases];
  for (const base of homes) {
    if (!base) continue;
    // base 本身是 JDK home？
    const direct = path.join(base, 'bin', exe);
    if (fs.existsSync(direct) && readJdkMajor(base) === MIN_MAJOR) return direct;
    if (!fs.existsSync(base)) continue;
    let st = null;
    try { st = fs.statSync(base); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    for (const entry of fs.readdirSync(base)) {
      const home = path.join(base, entry);
      const j = path.join(home, 'bin', exe);
      if (fs.existsSync(j) && readJdkMajor(home) === MIN_MAJOR) return j;
      // macOS 布局：xxx.jdk/Contents/Home
      const macHome = path.join(home, 'Contents', 'Home');
      const mj = path.join(macHome, 'bin', exe);
      if (fs.existsSync(mj) && readJdkMajor(macHome) === MIN_MAJOR) return mj;
    }
  }
  return null;
}

function hostAdoptTag() {
  const os = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'mac' : 'linux');
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return { os, arch };
}

/**
 * Windows 下绝不能信 PATH 命中的 tar：GitHub Actions 的 shell: bash 会把
 * Git Bash 的 /usr/bin 前置，命中的是 GNU tar——它把 "D:\\a\\..." 盘符冒号
 * 解析为「远程主机 D」的归档语法，报
 *   tar (child): Cannot connect to D: resolve failed
 * 再连锁 gzip: unexpected end of file（下载本身是完整的）。
 * 故钉死 System32 的 bsdtar（Win10+ 自带，无远程归档语法歧义，
 * 支持 -z 与 --strip-components，还能解 zip）。
 */
function resolveTar() {
  if (process.platform !== 'win32') return 'tar';
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (!fs.existsSync(sys)) fail('未找到系统 bsdtar: ' + sys);
  return sys;
}

function ensureHostJdk17() {
  const { os, arch } = hostAdoptTag();
  const dir = path.join(CACHE, 'jdk-host');
  const jlink = path.join(dir, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  if (fs.existsSync(jlink)) return jlink;
  fs.mkdirSync(CACHE, { recursive: true });
  const tgz = path.join(CACHE, 'jdk-host.' + (os === 'windows' ? 'zip' : 'tar.gz'));
  const url = 'https://api.adoptium.net/v3/binary/latest/17/ga/' + os + '/' + arch + '/jdk/hotspot/normal/eclipse';
  log('宿主无 JDK 17 jlink，下载宿主平台 Temurin JDK 17（仅首次）…');
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  execFileSync(curl, ['-fSL', '--ssl-no-revoke', '-o', tgz, url], { stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (os === 'windows') {
    // Windows 包是 zip：bsdtar 可直接解 zip（Win10+），且不受 PATH 里 GNU tar 干扰
    execFileSync(resolveTar(), ['-xf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
  } else {
    execFileSync(resolveTar(), ['-xzf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
  }
  if (!fs.existsSync(jlink)) fail('宿主 JDK 17 解包后无 jlink: ' + jlink);
  return jlink;
}

// ── 目标 Linux JDK jmods（下载或复用） ───────────────────────────────────────

function adoptiumJdkUrl(arch) {
  // arch: x64 | aarch64
  return 'https://api.adoptium.net/v3/binary/latest/17/ga/linux/' + arch + '/jdk/hotspot/normal/eclipse';
}

function ensureLinuxJdk(archTag) {
  // archTag: x64 | arm64（目录名口径）→ Adoptium 口径 x64 | aarch64
  const adoptArch = archTag === 'arm64' ? 'aarch64' : 'x64';
  const dir = path.join(CACHE, 'jdk-' + archTag);
  const marker = path.join(dir, 'jmods');
  if (fs.existsSync(marker)) {
    log('复用缓存 Linux JDK: ' + dir);
    return dir;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const tgz = path.join(CACHE, 'jdk-' + archTag + '.tar.gz');
  log('下载 Temurin JDK 17 linux ' + adoptArch + '（仅首次，缓存于 .cache）…');
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  // --ssl-no-revoke：Windows schannel 在无法访问吊销服务器（企业内网常见）时
  // 报 CRYPT_E_NO_REVOCATION_CHECK 直接失败；该旗标只跳过吊销检查，不降校验强度。
  execFileSync(curl, ['-fSL', '--ssl-no-revoke', '-o', tgz, adoptiumJdkUrl(adoptArch)], { stdio: 'inherit' });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = resolveTar();
  execFileSync(tar, ['-xzf', tgz, '-C', dir, '--strip-components=1'], { stdio: 'inherit' });
  if (!fs.existsSync(marker)) fail('解包后无 jmods 目录: ' + dir);
  return dir;
}

// ── jlink + 打包 ─────────────────────────────────────────────────────────────

function buildRuntime(jlink, jmodsHome, archTag, outDir) {
  const work = path.join(os.tmpdir(), 'gwork-runtime-' + archTag + '-' + process.pid);
  fs.rmSync(work, { recursive: true, force: true });
  log('jlink 链接 linux-' + archTag + ' 运行时…');
  execFileSync(
    jlink,
    [
      '--module-path', path.join(jmodsHome, 'jmods'),
      '--add-modules', JLINK_MODULES.join(','),
      '--output', work,
      '--strip-debug', '--compress', '2', '--no-header-files', '--no-man-pages',
    ],
    { stdio: 'inherit' }
  );
  if (!fs.existsSync(path.join(work, 'bin', 'java'))) {
    fail('jlink 产物缺少 bin/java: ' + work);
  }

  // 内嵌 manifest（远端/用户可自证来源与模块清单）
  let javaVersion = 'unknown';
  try {
    const m = fs.readFileSync(path.join(work, 'release'), 'utf8').match(/JAVA_VERSION="?([\d._+]+)/);
    if (m) javaVersion = m[1];
  } catch (e) { /* 保留 unknown */ }
  fs.writeFileSync(
    path.join(work, 'gwork-runtime.json'),
    JSON.stringify(
      {
        schema: 1,
        kind: 'gwork-remote-runtime',
        os: 'linux',
        arch: archTag === 'arm64' ? 'aarch64' : 'x86_64',
        javaVersion,
        jlinkModules: JLINK_MODULES,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );

  fs.mkdirSync(outDir, { recursive: true });
  const tarPath = path.join(outDir, 'runtime-linux-' + archTag + '.tar.gz');
  const tar = resolveTar();
  // flat 布局：-C work . → 条目 ./bin/java …（远端布局归一也兼容单层顶目录）
  execFileSync(tar, ['-czf', tarPath, '-C', work, '.'], { stdio: 'inherit' });
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');
  fs.writeFileSync(path.join(outDir, 'runtime-linux-' + archTag + '.tar.gz.sha256'), sha + '\n');
  log('产出: ' + tarPath + ' (' + mb(fs.statSync(tarPath).size) + ') sha256=' + sha.slice(0, 16) + '…');
  fs.rmSync(work, { recursive: true, force: true });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1];
  };
  const outDir = path.resolve(process.cwd(), get('--out') || DEFAULT_OUT);
  const archs = (get('--arch') || 'x64').split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of archs) {
    if (a !== 'x64' && a !== 'arm64') fail('未知架构: ' + a + '（支持 x64/arm64）');
  }

  const jlink = findHostJlink() || ensureHostJdk17();
  log('宿主 jlink: ' + jlink);

  for (const archTag of archs) {
    const preset = get('--jdk-' + archTag);
    const jmodsHome = preset ? path.resolve(process.cwd(), preset) : ensureLinuxJdk(archTag);
    if (!fs.existsSync(path.join(jmodsHome, 'jmods'))) {
      fail('--jdk-' + archTag + ' 指向的目录无 jmods: ' + jmodsHome);
    }
    buildRuntime(jlink, jmodsHome, archTag, outDir);
  }
  log('完成: ' + outDir);
}

main();
