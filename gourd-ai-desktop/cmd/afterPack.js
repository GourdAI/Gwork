/**
 * electron-builder afterPack 钩子
 *
 * 按平台分派两件事：
 *   - Windows：把内置 JRE 的 exe 版本资源改写为 GWork 品牌（防火墙弹窗 / 任务管理器）；
 *   - macOS：对 .app 做 ad-hoc 签名。
 *
 * ── macOS ad-hoc 签名 ──
 * 背景：无 Apple 开发者证书时，electron-builder 会完全跳过签名流程。
 * 而 Apple Silicon (arm64) 的 macOS 要求所有可执行文件至少具备 ad-hoc 签名，
 * 否则 Gatekeeper 直接报「文件已损坏，无法打开」，且右键→打开也无法绕过
 * （x64 包走 Rosetta，检查宽松，故只有 arm64 包触发）。
 *
 * 本钩子用系统 codesign 以 ad-hoc 身份（"-"）签名并密封资源，
 * 把报错降级为可绕过的「无法验证开发者」提示（右键→打开 即可）。
 * 彻底免提示需要付费 Developer ID 签名 + 公证（notarize）。
 *
 * 注意：配置了 CSC_LINK / CSC_KEY_PASSWORD（或本地钥匙串有 Developer ID 证书）时，
 * electron-builder 会用真实证书签名，本钩子自动跳过，避免 ad-hoc 覆盖真实签名。
 */
const { execFileSync } = require('child_process');
const path = require('path');

const { brandJre } = require('./brand-jre.js');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') {
    // 在 NSIS 打包前对已解包产物处理，改动会被收进安装包
    const jreDir = path.join(context.appOutDir, 'resources', 'extraResources', 'jre');
    // 打标失败不阻断出包：品牌化属观感优化，缺失只是弹窗仍显示 OpenJDK，不影响功能
    if (!brandJre(jreDir)) {
      console.warn('[afterPack] JRE 品牌化未完全成功，安装包仍可用（弹窗可能显示 OpenJDK 字样）');
    }
    return;
  }

  // 以下仅 macOS 产物需要处理
  if (context.electronPlatformName !== 'darwin') return;

  // 有真实证书时由 electron-builder 官方签名流程处理（含公证），此处不干预
  if (process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD) {
    console.log('[afterPack] 检测到 CSC_LINK，交由 electron-builder 正式签名，跳过 ad-hoc');
    return;
  }

  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);

  console.log('[afterPack] ad-hoc 签名: ' + appPath);

  // --deep 递归签名内嵌的 Framework / Helper 等嵌套 bundle；
  // --force 覆盖链接器自带的不完整签名；-s - 表示 ad-hoc 身份（无需证书）
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' }
  );

  // 校验签名与资源密封，失败立即抛错，避免 CI 产出「损坏包」
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' }
  );

  console.log('[afterPack] 签名校验通过: ' + appName);
};
