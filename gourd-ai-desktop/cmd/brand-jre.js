'use strict';

/**
 * brand-jre.js —— 把内置 JRE 各 exe 的 Windows 版本资源改写为 GWork 品牌
 *
 * 动机：Windows 防火墙首次弹窗显示的程序名，取自该 exe 版本资源里的 FileDescription
 * 字段（不是文件名、也不是签名）。内置 JRE 由 jlink 生成，该字段是上游 JDK 的
 * "OpenJDK Platform binary"，用户看到的弹窗与任务管理器条目因此都与 GWork 无关。
 * 本脚本原位重写该字段（及 ProductName/CompanyName），使两处都显示 GWork。
 *
 * 只改资源、不改文件名：backend.js / cli-provision.js / dev-launch.js 中对
 * javaw.exe、java.exe 的硬编码路径全部保持有效，无需同步改动。
 *
 * 诚实性：OriginalFilename 与 InternalName 保留上游原值（java/javaw/keytool），
 * "Full Version" 保留 JDK 构建号，据此仍可辨明二进制的真实出身。
 *
 * 安全性：内置 JRE 未经数字签名（jlink 产物），改写版本资源不会破坏任何签名。
 * 若将来改用已签名的 JRE，本脚本会跳过带证书的 exe 并给出提示（见 SKIP_SIGNED）。
 */

const fs = require('fs');
const path = require('path');

/** 需要打标的 exe → 该文件在产品中承担的角色描述（写入 FileDescription） */
const TARGETS = {
  'javaw.exe': 'GWork',      // 后端服务进程：防火墙弹窗与任务管理器显示的就是它
  'java.exe': 'GWork CLI',   // CLI 启动器：需要 stdio，故用控制台版
  'keytool.exe': 'GWork',    // 随 jlink 附带，一并打标避免露出 OpenJDK 字样
};

const COMPANY_NAME = 'GWork';
const PRODUCT_NAME = 'GWork';
const COPYRIGHT = 'Copyright (c) 2026 GWork';

/** 已打过标则跳过，使脚本可重复执行（afterPack 可能对同一目录多次运行） */
function alreadyBranded(values) {
  return values.CompanyName === COMPANY_NAME && values.ProductName === PRODUCT_NAME;
}

/**
 * 改写单个 exe 的版本资源。
 * @returns {'branded'|'skipped-branded'|'skipped-nores'|'skipped-signed'}
 */
function brandOne(exePath, fileDescription, ResEdit) {
  const buf = fs.readFileSync(exePath);

  // 带 Authenticode 证书的二进制：改写会使签名失效，直接跳过（当前 jlink 产物无签名）
  let exe;
  try {
    exe = ResEdit.NtExecutable.from(buf);
  } catch (e) {
    if (/certificate/i.test(String(e && e.message))) {
      return 'skipped-signed';
    }
    throw e;
  }

  const res = ResEdit.NtExecutableResource.from(exe);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (versions.length === 0) {
    return 'skipped-nores';
  }

  let changed = false;
  for (const vi of versions) {
    // 同一 exe 可能带多语言字符串表，逐个语言改写，避免只改英文导致中文系统仍显示旧值
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
      changed = true;
    }
    if (changed) {
      vi.outputToResourceEntries(res.entries);
    }
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
 * 对指定 jre 目录下的 bin/*.exe 批量打标。
 * @param {string} jreDir 形如 <resources>/extraResources/jre
 * @returns {boolean} 是否成功完成（失败不抛出，由调用方决定是否阻断）
 */
function brandJre(jreDir) {
  if (process.platform !== 'win32') {
    // 版本资源是 PE 格式特性，非 Windows 产物无此概念
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
    ResEdit = require('resedit');
  } catch (e) {
    console.warn('[brand-jre] 缺少 resedit 依赖，跳过品牌化: ' + (e && e.message));
    return false;
  }

  let ok = true;
  for (const name of Object.keys(TARGETS)) {
    const exePath = path.join(binDir, name);
    if (!fs.existsSync(exePath)) {
      continue; // jlink 模块组合变化时某些 exe 可能不存在，属正常情况
    }
    try {
      const result = brandOne(exePath, TARGETS[name], ResEdit);
      if (result === 'branded') {
        console.log('[brand-jre] 已打标: ' + name + ' → "' + TARGETS[name] + '"');
      } else if (result === 'skipped-branded') {
        console.log('[brand-jre] 已是 GWork 品牌，跳过: ' + name);
      } else if (result === 'skipped-signed') {
        console.log('[brand-jre] 该 exe 带数字签名，跳过以免破坏签名: ' + name);
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

// 支持直接执行：node cmd/brand-jre.js [jreDir]
// 未传参时默认处理 build/extraResources/jre（generate-jre.js 的产出位置）
if (require.main === module) {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, '..', 'build', 'extraResources', 'jre');
  console.log('[brand-jre] 目标: ' + target);
  const ok = brandJre(target);
  process.exit(ok ? 0 : 1);
}
