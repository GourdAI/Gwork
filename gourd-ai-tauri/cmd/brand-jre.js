'use strict';

/**
 * brand-jre.js —— 把内置 JRE 各 exe 的 Windows 版本资源与图标改写为 GWork 品牌
 *
 * 动机：Windows 防火墙首次弹窗显示的**程序名**取自该 exe 版本资源里的 FileDescription
 * 字段（不是文件名、也不是签名），而弹窗左上角的**图标**取自该 exe 的 RT_GROUP_ICON
 * 资源。内置 JRE 由 jlink 生成，两者都是上游 JDK 的原值（"OpenJDK Platform binary" +
 * Java 咖啡杯图标），用户看到的弹窗与任务管理器条目因此都与 GWork 无关。
 * 本脚本原位重写这两类资源，使弹窗的名字与图标都属于 GWork。
 *
 * 【图标为何必须一并改（2026-09 实测补齐）】
 * 早先只改了版本资源，于是防火墙弹窗变成「名字是 GWork、图标是 Java 咖啡杯」的割裂状态。
 * 实测：Electron 已打包产物里 javaw.exe 的图标资源与主程序 GWork.exe **并不相同**
 * （前者 9144B 上游咖啡杯，后者 29986B 品牌图）—— 两个桌面壳都缺这一步，不是单边遗漏。
 *
 * 只改资源、不改文件名：backend.js / cli-provision.js / dev-launch.js 中对
 * javaw.exe、java.exe 的硬编码路径全部保持有效，无需同步改动。
 *
 * 【本文件的归属（2026-09-12 拆分）】
 * 这是 **Tauri 侧的自有副本**，与 Electron 的 `gourd-ai-desktop/cmd/brand-jre.js`
 * 同源。此前两端共用 Electron 模块里那一份（tauri.conf.json 里写的是
 * `node ../gourd-ai-desktop/cmd/brand-jre.js`），一旦把 Tauri 拆成独立仓库，
 * 这条跨模块路径立刻失效。现各持一份、各自演进：改 Tauri 的品牌化请改本文件，
 * 不要把 ../gourd-ai-desktop 的引用再请回来。同类拆分见 cmd/gen-build-manifest.js。
 *
 * 调用方：Tauri 的 beforeBuildCommand（Tauri 无 afterPack 概念，故在打包前对
 * gourd-ai-tauri/build/extraResources/jre 直接打标），以及 `npm run brand-jre`。
 *
 * 诚实性：OriginalFilename 与 InternalName 保留上游原值（java/javaw/keytool），
 * "Full Version" 保留 JDK 构建号，据此仍可辨明二进制的真实出身。
 *
 * 【签名与本脚本的关系（2026-09 实测修正）】
 * 原先此处写的是「jlink 产物未经数字签名，改写不会破坏签名」——**该前提不成立**。
 * jlink 只是从 jmods 里原样复制 bin/*.exe，是否带 Authenticode 完全取决于上游厂商：
 *   - JetBrains Runtime 的 jlink 产物：无签名（Electron 侧一直能打标，故未暴露问题）
 *   - Amazon Corretto / Temurin 等：**带有效签名** → resedit 默认拒绝解析，抛
 *     "Parsing signed executable binary is not allowed by default."
 * 而旧的跳过判据是 /certificate/i，匹配不到这句话，于是签名 exe 既没被跳过也没被打标，
 * 而是记成「打标失败」——品牌化在这类 JDK 上静默失效。
 *
 * 现在的策略：默认 ignoreCert 解析并打标，代价是**产出的 exe 不再携带上游厂商签名**。
 * 这是有意权衡：
 *   1. 本功能的全部意义就是让防火墙弹窗/任务管理器显示 GWork，跳过=功能不存在；
 *   2. 该 exe 是嵌在我方安装包内的 jlink 产物，Windows 不要求内嵌二进制自带签名，
 *      且我方 Windows 包本就未做代码签名，上游签名在此并无实际保护作用；
 *   3. 需要保留上游签名时设 GWORK_BRAND_SKIP_SIGNED=1，此时带签名的 exe 原样跳过。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// PE 资源类型常量（winuser.h）
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

/** 需要打标的 exe → 该文件在产品中承担的角色描述（写入 FileDescription） */
const TARGETS = {
  'javaw.exe': 'GWork',      // 后端服务进程：防火墙弹窗与任务管理器显示的就是它
  'java.exe': 'GWork CLI',   // CLI 启动器：需要 stdio，故用控制台版
  'keytool.exe': 'GWork',    // 随 jlink 附带，一并打标避免露出 OpenJDK 字样
};

const COMPANY_NAME = 'GWork';
const PRODUCT_NAME = 'GWork';
const COPYRIGHT = 'Copyright (c) 2026 GWork';

// 置 1 时保留上游厂商签名：带签名的 exe 原样跳过、不打标（见文件头「签名与本脚本的关系」）
const SKIP_SIGNED = process.env.GWORK_BRAND_SKIP_SIGNED === '1';

/** resedit 对已签名二进制抛的错误（不含 "certificate" 字样，必须按原文匹配） */
function isSignedBinaryError(e) {
  return /signed executable/i.test(String(e && e.message));
}

/** 已打过标则跳过，使脚本可重复执行（afterPack 可能对同一目录多次运行） */
function alreadyBranded(values) {
  return values.CompanyName === COMPANY_NAME && values.ProductName === PRODUCT_NAME;
}

/**
 * 加载 resedit。本模块的 package.json 已把 resedit 列为 devDependency
 * （CI 在 gourd-ai-tauri/ 下 npm install 即可装上），按本文件位置直接解析就行。
 *
 * 此前需要「回落到调用方 cwd」是因为脚本当时寄居在 Electron 模块里，而那边未必装过
 * resedit。副本独立后那条兜底已无必要，保留它只会掩盖「依赖没装」这类真实错误。
 */
function requireResEdit() {
  return require('resedit');
}

/** RT_ICON 资源的内容指纹，用于判定图标是否已是目标图（支撑幂等） */
function iconFingerprint(entries) {
  const bins = entries
    .filter((e) => e.type === RT_ICON)
    .map((e) => Buffer.from(e.bin));
  if (bins.length === 0) return '';
  return crypto.createHash('sha256').update(Buffer.concat(bins)).digest('hex');
}

/**
 * 把品牌 ico 写入 exe 的图标资源。
 *
 * 图标组 ID 固定用现有第一组（而非新增）：Shell 与防火墙取的是**ID 最小的**
 * RT_GROUP_ICON，另起一组会被忽略，表现为「改了但没生效」。
 * @returns {boolean} 图标是否发生变更
 */
function applyIcon(res, ResEdit, iconPath) {
  const before = iconFingerprint(res.entries);

  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const icons = ico.icons.map((it) => it.data);

  const groups = res.entries.filter((e) => e.type === RT_GROUP_ICON);
  // 上游 java.exe/javaw.exe 均带恰好一组图标；若上游改成无图标，则新建 ID=1。
  const groupId = groups.length > 0
    ? groups.map((g) => g.id).sort((a, b) => (a > b ? 1 : -1))[0]
    : 1;
  const lang = groups.length > 0 ? groups[0].lang : 1033;

  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, icons);

  return iconFingerprint(res.entries) !== before;
}

/**
 * 改写单个 exe 的版本资源与图标。
 * @param {string|null} iconPath 品牌 ico 路径；null 表示不动图标
 * @returns {'branded'|'skipped-branded'|'skipped-nores'|'skipped-signed'}
 */
function brandOne(exePath, fileDescription, ResEdit, iconPath) {
  const buf = fs.readFileSync(exePath);

  // 带 Authenticode 证书的二进制：resedit 默认拒绝解析。默认用 ignoreCert 强行解析并打标
  // （产物不再带上游签名，权衡理由见文件头）；GWORK_BRAND_SKIP_SIGNED=1 时改为原样跳过。
  let exe;
  try {
    exe = ResEdit.NtExecutable.from(buf);
  } catch (e) {
    if (!isSignedBinaryError(e)) throw e;
    if (SKIP_SIGNED) {
      return 'skipped-signed';
    }
    exe = ResEdit.NtExecutable.from(buf, { ignoreCert: true });
  }

  const res = ResEdit.NtExecutableResource.from(exe);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (versions.length === 0) {
    return 'skipped-nores';
  }

  let changed = false;
  for (const vi of versions) {
    // 同一 exe 可能带多语言字符串表，逐个语言改写，避免只改英文导致中文系统仍显示旧值
    let viChanged = false;
    for (const lang of vi.getAllLanguagesForStringValues()) {
      const values = vi.getStringValues(lang);
      if (alreadyBranded(values)) {
        continue;
      }
      vi.setStringValues(lang, {
        FileDescription: fileDescription,
        CompanyName: COMPANY_NAME,
        ProductName: PRODUCT_NAME,
        LegalCopyright: COPYRIGHT,
      });
      viChanged = true;
    }
    if (viChanged) {
      vi.outputToResourceEntries(res.entries);
      changed = true;
    }
  }

  // 图标独立于版本资源判定：早期版本只改了字符串，那些 exe 的 CompanyName 已是 GWork
  // 但图标仍是咖啡杯。若把图标挂在 alreadyBranded 下，这批 exe 会被永久跳过。
  if (iconPath && applyIcon(res, ResEdit, iconPath)) {
    changed = true;
  }

  if (!changed) {
    return 'skipped-branded';
  }

  res.outputResource(exe);

  // 原子写：先落临时文件再 rename，避免写入中途失败留下损坏的 exe
  const tmp = exePath + '.branding.tmp';
  fs.writeFileSync(tmp, Buffer.from(exe.generate()));
  fs.rmSync(exePath, { force: true });
  fs.renameSync(tmp, exePath);
  return 'branded';
}

/**
 * 推断品牌 ico 路径。取 tauri.conf.json 里 bundle.icon 的唯一图标源
 * `<模块根>/src-tauri/icons/icon.ico`（本文件在 cmd/ 下，故为 ../src-tauri/...）。
 * 取不到时返回 null（降级为只改版本资源，弹窗名字仍是对的）。
 */
function resolveIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico'),
    path.join(process.cwd(), 'src-tauri', 'icons', 'icon.ico'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * 对指定 jre 目录下的 bin/*.exe 批量打标。
 * @param {string} jreDir 形如 <resources>/extraResources/jre
 * @param {object} [opts]
 * @param {string} [opts.iconPath] 品牌 ico；缺省按调用方模块推断（见 resolveIconPath）
 * @returns {boolean} 是否成功完成（失败不抛出，由调用方决定是否阻断）
 */
function brandJre(jreDir, opts = {}) {
  if (process.platform !== 'win32') {
    // 版本资源与 RT_ICON 都是 PE 格式特性，非 Windows 产物无此概念
    console.log('[brand-jre] 非 Windows 平台，跳过');
    return true;
  }

  const binDir = path.join(jreDir, 'bin');
  if (!fs.existsSync(binDir)) {
    console.warn('[brand-jre] 未找到 JRE bin 目录，跳过: ' + binDir);
    return false;
  }

  let ResEdit;
  try {
    ResEdit = requireResEdit();
  } catch (e) {
    console.warn('[brand-jre] 缺少 resedit 依赖，跳过品牌化: ' + (e && e.message));
    return false;
  }

  // 图标缺失不阻断：降级为「只改版本资源」，至少弹窗名字是对的
  let iconPath = opts.iconPath === undefined ? resolveIconPath() : opts.iconPath;
  if (iconPath && !fs.existsSync(iconPath)) {
    console.warn('[brand-jre] 品牌图标不存在，本次只改版本资源: ' + iconPath);
    iconPath = null;
  }
  if (iconPath) {
    console.log('[brand-jre] 图标源: ' + iconPath);
  }

  let ok = true;
  for (const name of Object.keys(TARGETS)) {
    const exePath = path.join(binDir, name);
    if (!fs.existsSync(exePath)) {
      continue; // jlink 模块组合变化时某些 exe 可能不存在，属正常情况
    }
    try {
      const result = brandOne(exePath, TARGETS[name], ResEdit, iconPath);
      if (result === 'branded') {
        console.log('[brand-jre] 已打标: ' + name + ' → "' + TARGETS[name] + '"'
          + (iconPath ? ' + 品牌图标' : ''));
      } else if (result === 'skipped-branded') {
        console.log('[brand-jre] 已是 GWork 品牌（含图标），跳过: ' + name);
      } else if (result === 'skipped-signed') {
        console.log('[brand-jre] 带数字签名且已设 GWORK_BRAND_SKIP_SIGNED=1，保留签名不打标: ' + name);
      } else {
        console.warn('[brand-jre] 无版本资源，跳过: ' + name);
      }
    } catch (e) {
      // 单个文件失败不影响其余文件；整体结果标记为失败，由调用方决定处理方式
      console.warn('[brand-jre] 打标失败 ' + name + ': ' + (e && e.message));
      ok = false;
    }
  }
  return ok;
}

module.exports = { brandJre };

// 支持直接执行：node cmd/brand-jre.js [jreDir] [--no-fail]
// 未传参时默认处理 build/extraResources/jre（cmd/sync-backend.js 的产出位置）；
// jreDir 为相对路径时按**进程 cwd** 解析（同 gen-build-manifest.js 的 --extra-dir），
// 在 gourd-ai-tauri/ 下写 `build/extraResources/jre` 才能如字面所期。
//
// --no-fail：打标失败仍以 0 退出。供 Tauri 的 beforeBuildCommand 使用 —— 那条链用 `&&`
// 串联，默认的非零退出会直接中断打包，而品牌化属观感优化（失败只是弹窗仍显示
// OpenJDK 字样，不影响功能），不应为此卡掉整个发布。语义与 Electron 侧 afterPack.js
// 的「打标失败不阻断出包」保持一致。
if (require.main === module) {
  const args = process.argv.slice(2);
  const noFail = args.includes('--no-fail');
  const dirArg = args.find((a) => !a.startsWith('--'));
  const target = dirArg
    ? path.resolve(process.cwd(), dirArg)
    : path.join(__dirname, '..', 'build', 'extraResources', 'jre');
  console.log('[brand-jre] 目标: ' + target);
  const ok = brandJre(target);
  if (!ok && noFail) {
    console.warn('[brand-jre] 品牌化未完全成功，已按 --no-fail 继续构建'
      + '（安装包仍可用，防火墙弹窗可能显示 OpenJDK 字样）');
  }
  process.exit(ok || noFail ? 0 : 1);
}
