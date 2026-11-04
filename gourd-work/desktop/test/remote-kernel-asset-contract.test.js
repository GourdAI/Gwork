/* 远端内核资产的命名契约：CI 产物名 ↔ tauri 资源映射 ↔ paths.rs 候选 ↔ deploy.rs 二进制名
 *
 * 缺陷机制（本次实测确认，非推理）：远程工作空间把内核二进制打进安装包、部署到远端。
 * 这条链上有四处独立写死「gwork」/「gwork-linux-<arch>」，任一处漂移都是**静默**故障：
 *   - CI 的 asset 名与 paths.rs 拼出的候选文件名不一致 → 发布版连远端时报
 *     「读取本地内核二进制失败」，而本地 cargo test 全绿（开发态走 target/release/gwork
 *     回落，根本不碰这个资产目录）；
 *   - tauri.conf.json 的 resources 落点与 CI 下载落点不一致 → 打包成功、安装成功、
 *     资产却不在包里，同样只在连远端时才暴露；
 *   - deploy.rs 的 KERNEL_BIN 与 tar 条目名/远端验收/启动路径不一致 → 部署「成功」
 *     但启动 not found，表现为 180s 探活超时，根因完全不可见。
 *
 * 本测试直接读四个源文件、逐字比对，把这条链钉死。它跑在 desktop/test（CI gate 的
 * `node --test test/*.test.js` 会执行），而不是 desktop crate 的 Rust 测试——后者被
 * gate 排除（Linux 无 WebKitGTK），放那里等于没有护栏。
 *
 * 为什么不做成「解析 YAML/正则重新实现一遍命名逻辑」：那只是把重复搬到测试里，
 * 两边仍会一起漂移。这里只提取**字面量**再交叉断言，任何一边改了字面量而另一边没跟，
 * 测试当场红。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..', '..'); // gourdai 仓库根
const PATHS_RS = fs.readFileSync(path.join(DESKTOP, 'src-tauri', 'src', 'paths.rs'), 'utf8');
const DEPLOY_RS = fs.readFileSync(path.join(DESKTOP, 'src-tauri', 'src', 'remote', 'deploy.rs'), 'utf8');
const TAURI_CONF = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const CI_YML = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'build-gourd-work.yml'), 'utf8');

// ── 从各源提取字面量 ────────────────────────────────────────────────

// paths.rs: const KERNEL_BIN_NAME: &str = "gwork";
function pathsKernelBinName() {
  const m = PATHS_RS.match(/const\s+KERNEL_BIN_NAME:\s*&str\s*=\s*"([^"]+)"/);
  assert.ok(m, 'paths.rs 必须有 KERNEL_BIN_NAME 常量');
  return m[1];
}
// deploy.rs: pub const KERNEL_BIN: &str = "gwork";
function deployKernelBin() {
  const m = DEPLOY_RS.match(/pub\s+const\s+KERNEL_BIN:\s*&str\s*=\s*"([^"]+)"/);
  assert.ok(m, 'deploy.rs 必须有 KERNEL_BIN 常量');
  return m[1];
}
// paths.rs kernel_asset_tag: (platform, arch) → tag。直接抓 Linux 分支的两个字面量。
function pathsLinuxTags() {
  // "Linux" => Some(if arch_tag == "x64" { "linux-x64" } else { "linux-aarch64" }),
  const m = PATHS_RS.match(/"Linux"\s*=>\s*Some\([^)]*"(linux-x64)"[^)]*"(linux-aarch64)"/);
  assert.ok(m, 'paths.rs kernel_asset_tag 必须有 Linux x64/aarch64 两个 tag 字面量');
  return { x64: m[1], aarch64: m[2] };
}
// paths.rs remote_kernel_candidates 的拼接形态：format!("{}-{}", KERNEL_BIN_NAME, t)
// 即候选文件名 = KERNEL_BIN_NAME + "-" + tag。抓这个拼接式，确认候选就是「名-tag」。
function pathsCandidateJoinShape() {
  return PATHS_RS.includes('format!("{}-{}", KERNEL_BIN_NAME, t)');
}
// CI: kernel-assets job 的 (target, asset) 对
function ciKernelAssets() {
  const seg = CI_YML.split('kernel-assets:')[1] || '';
  const pairs = [];
  const re = /-\s*target:\s*(\S+)\s*\n\s*asset:\s*(\S+)/g;
  let m;
  while ((m = re.exec(seg)) !== null) pairs.push({ target: m[1], asset: m[2] });
  assert.ok(pairs.length >= 2, 'CI kernel-assets 必须至少两个 target/asset 对，实得 ' + pairs.length);
  return pairs;
}
// CI: 静态 ELF 校验步骤的脚本体（从 "- name: 校验产物是静态 ELF" 到下一个步骤）
function ciStaticCheckStep() {
  const seg = CI_YML.split('name: 校验产物是静态 ELF')[1] || '';
  const body = seg.split(/\n\s+- name:/)[0];
  assert.ok(body, 'CI 必须有「校验产物是静态 ELF」步骤');
  return body;
}
// CI: 该文件用来匹配 `file` 输出的正则字面量。测试直接复用它跑代表性样本，
// 而不是在测试里另写一份正则 —— 另写一份只会两边一起漂移，等于没有护栏。
function ciStaticFilePattern() {
  const body = ciStaticCheckStep();
  const m = body.match(/grep\s+-Eqi\s+'([^']+)'/);
  assert.ok(m, 'CI 静态校验必须用 grep -Eqi 接受多种静态措辞');
  return new RegExp(m[1], 'i');
}
// CI: 下载内核资产的 pattern 与落点
function ciDownload() {
  const dl = CI_YML.split('name: 下载内核资产')[1] || '';
  const pat = (dl.match(/pattern:\s*(\S+)/) || [])[1];
  const p = (dl.match(/path:\s*(\S+)/) || [])[1];
  assert.ok(pat, 'CI 下载内核资产步骤必须有 pattern');
  assert.ok(p, 'CI 下载内核资产步骤必须有 path');
  return { pattern: pat, path: p };
}

// ── 契约断言 ────────────────────────────────────────────────────────

test('paths.rs 与 deploy.rs 的内核二进制名逐字一致', () => {
  // 两处独立写死，不一致就会「tar 里叫 A、远端启动找 B」→ not found → 探活超时。
  assert.strictEqual(pathsKernelBinName(), deployKernelBin(),
    `paths.rs KERNEL_BIN_NAME=${pathsKernelBinName()} 必须等于 deploy.rs KERNEL_BIN=${deployKernelBin()}`);
  assert.strictEqual(deployKernelBin(), 'gwork',
    '内核二进制名必须是 gwork（CI 产物名与 command -v gwork 探测都依赖它）');
});

test('CI 内核资产名 = paths.rs 的「名-tag」候选文件名', () => {
  const bin = pathsKernelBinName();
  const tags = pathsLinuxTags();
  assert.ok(pathsCandidateJoinShape(),
    'paths.rs 候选必须是 format!("{}-{}", KERNEL_BIN_NAME, t) 形态（否则下面的逐字比对失效）');
  // paths.rs 对 Linux x64 / aarch64 拼出的候选文件名
  const expected = {
    'x86_64-unknown-linux-musl': `${bin}-${tags.x64}`,
    'aarch64-unknown-linux-musl': `${bin}-${tags.aarch64}`,
  };
  const pairs = ciKernelAssets();
  for (const { target, asset } of pairs) {
    assert.ok(expected[target],
      `CI target ${target} 不在 paths.rs 覆盖的 Linux musl target 里（paths.rs 只认 x86_64/aarch64-unknown-linux-musl）`);
    assert.strictEqual(asset, expected[target],
      `CI asset 名 ${asset} 必须等于 paths.rs 拼出的候选 ${expected[target]}（target=${target}）`);
  }
});

test('CI 资产名符合 kernel_asset_tag 的平台-架构后缀口径', () => {
  // 双保险：不依赖上面的拼接式正则，直接锁 CI 两个 asset 的字面值。
  const assets = ciKernelAssets().map((p) => p.asset).sort();
  assert.deepStrictEqual(assets, ['gwork-linux-aarch64', 'gwork-linux-x64'],
    'CI 内核资产名必须是 gwork-linux-x64 / gwork-linux-aarch64（与 paths.rs kernel_asset_tag 对齐）');
});

test('CI 下载 pattern 覆盖全部内核资产名', () => {
  const { pattern } = ciDownload();
  // archive:false 下 artifact 名 = 文件 basename = asset 名，故 pattern 必须匹配它们。
  const globRe = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  for (const { asset } of ciKernelAssets()) {
    assert.ok(globRe.test(asset),
      `CI 下载 pattern ${pattern} 匹配不到 asset ${asset}（会静默零产物）`);
  }
});

test('CI 下载落点与 tauri resources 源目录逐字一致', () => {
  const dl = ciDownload();
  // CI: gourd-work/desktop/build/extraResources/kernels
  assert.match(dl.path, /gourd-work\/desktop\/build\/extraResources\/kernels$/,
    'CI 下载落点必须是 desktop/build/extraResources/kernels');
  // tauri.conf.json: "../build/extraResources/kernels/": "extraResources/kernels/"
  const res = TAURI_CONF.bundle.resources || {};
  const srcKey = Object.keys(res).find((k) => k.includes('build/extraResources/kernels'));
  assert.ok(srcKey, 'tauri.conf.json bundle.resources 必须有 build/extraResources/kernels 映射');
  assert.strictEqual(res[srcKey], 'extraResources/kernels/',
    'tauri 资源 target 必须是 extraResources/kernels/（paths.rs 在 resources_dir()/kernels/ 找资产）');
  // resources_dir() 发布态落在 <exe>/extraResources，故 target 的 extraResources/kernels/
  // 正好对上 paths.rs 的 base.join("kernels")。
});

test('paths.rs 发布态候选把 kernels/ 子目录排在带后缀资产之前', () => {
  // remote_kernel_candidates 的候选顺序：带后缀 → 不带后缀 → 裸名。
  // 带后缀必须在最前，否则多平台资产共存时会选错架构（mac 远端命中 linux 资产 → 启动崩）。
  const fnSeg = PATHS_RS.split('pub fn remote_kernel_candidates')[1].split('\n}')[0];
  const iTagged = fnSeg.indexOf('format!("{}-{}", KERNEL_BIN_NAME, t)');
  const iPlainKernels = fnSeg.indexOf('base.join("kernels").join(KERNEL_BIN_NAME)');
  const iBare = fnSeg.indexOf('base.join(KERNEL_BIN_NAME)');
  assert.ok(iTagged >= 0 && iPlainKernels >= 0 && iBare >= 0, '三个候选都必须在');
  assert.ok(iTagged < iPlainKernels, '带平台后缀的候选必须排在不带后缀之前');
  assert.ok(iPlainKernels < iBare, 'kernels/ 子目录候选必须排在裸名之前');
});

// ── 静态 ELF 校验判据（run 41797867972 的回归护栏）──────────────────────
//
// rustc 对 x86_64-unknown-linux-musl 产出静态 PIE（ET_DYN，`file` 报
// "static-pie linked"），对 aarch64-unknown-linux-musl 产出普通静态（ET_EXEC，
// `file` 报 "statically linked"）。旧校验只认后者，于是同一次 run 里 x64 红、
// aarch64 绿——被误杀的是完全合规、零动态依赖的二进制。
//
// 这里直接取 CI 里的正则跑代表性样本：既锁住两种合法措辞，也锁住「动态链接
// 必须被拒」，防止有人为了消红把校验放宽成无条件放行。
test('CI 静态校验同时接受普通静态与静态 PIE 的 file 描述', () => {
  const re = ciStaticFilePattern();
  const cases = [
    // run 41797867972 的真实输出（x64，旧断言误杀的那一行）
    ['target/x86_64-unknown-linux-musl/release/gwork: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), static-pie linked, stripped', true],
    // aarch64 的普通静态输出
    ['target/aarch64-unknown-linux-musl/release/gwork: ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, stripped', true],
    // 大小写与措辞变体（file 版本演进）
    ['ELF 64-bit LSB pie executable, x86-64, STATIC-PIE LINKED, stripped', true],
    // 动态链接：绝不能放行，否则 musl 承诺彻底失守
    ['ELF 64-bit LSB pie executable, x86-64, dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, for GNU/Linux 3.2.0, stripped', false],
    ['ELF 64-bit LSB executable, x86-64, dynamically linked, stripped', false],
  ];
  for (const [sample, expected] of cases) {
    assert.strictEqual(re.test(sample), expected,
      `静态判据对 ${JSON.stringify(sample)} 应返回 ${expected}`);
  }
  // 兜底：不许退回只认单一措辞的旧写法（它会静默重新引入 x64 误杀）。
  assert.doesNotMatch(ciStaticCheckStep(), /grep\s+-qi\s+"statically linked"/,
    '不可退回只认 "statically linked" 的单一措辞断言');
});

test('CI 静态校验含不依赖 file 措辞的结构复核（PT_INTERP / DT_NEEDED）', () => {
  const body = ciStaticCheckStep();
  // 文本层再怎么演进，静态性的本质判据是「没有动态加载器、没有共享库依赖」。
  assert.match(body, /readelf\s+-lW/, '必须读 ELF 程序头（readelf -lW）');
  assert.match(body, /readelf\s+-dW/, '必须读 ELF 动态段（readelf -dW）');
  assert.match(body, /INTERP/, '必须拒绝 PT_INTERP（依赖 ld.so）');
  assert.match(body, /\(NEEDED\)/, '必须拒绝 DT_NEEDED（链接共享库）');
  assert.match(body, /command\s+-v\s+readelf/, 'readelf 缺失必须硬失败而不是静默跳过');
});
