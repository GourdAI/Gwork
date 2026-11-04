#!/usr/bin/env node
'use strict';
/**
 * generate-jre.js - 自动查找 JDK 并生成精简 JRE
 * 用法：node generate-jre.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 编译目标为 Java 17，内置 JRE 必须 >= 17，否则运行时 UnsupportedClassVersionError。
const MIN_MAJOR = 17;

/** 读取某个 JDK/JRE 主目录的主版本号（从 <home>/release 的 JAVA_VERSION 解析）；失败返回 0。 */
function readJdkMajor(home) {
  try {
    const releaseFile = path.join(home, 'release');
    const text = fs.readFileSync(releaseFile, 'utf8');
    const m = text.match(/JAVA_VERSION="?(\d+)/);
    if (m) {
      return parseInt(m[1], 10);
    }
  } catch (e) {
    // 忽略：无 release 文件或读取失败
  }
  return 0;
}

/** 该目录是否为可用的 JDK（含 jlink）且版本达标（>= MIN_MAJOR）。 */
function isUsableJdk(home) {
  const jlink = path.join(home, 'bin',
    process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  if (!fs.existsSync(jlink)) {
    return false;
  }
  return readJdkMajor(home) >= MIN_MAJOR;
}

/** 在一个基目录下挑出版本达标、且主版本号最高的 JDK 子目录。 */
function pickBestInDir(base) {
  if (!fs.existsSync(base)) {
    return null;
  }
  let best = null;
  let bestMajor = 0;
  for (const entry of fs.readdirSync(base)) {
    const home = path.join(base, entry);
    if (!isUsableJdk(home)) {
      continue;
    }
    const major = readJdkMajor(home);
    if (major > bestMajor) {
      bestMajor = major;
      best = home;
    }
  }
  return best;
}

function findJavaHome() {
  // 1. 环境变量 JAVA_HOME（仅当版本达标）
  if (process.env.JAVA_HOME && isUsableJdk(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }

  // 2. IntelliJ 下载的 JDK（~/.jdks/）
  const fromIdea = pickBestInDir(path.join(os.homedir(), '.jdks'));
  if (fromIdea) {
    console.log(`✓ 找到 JDK: ${fromIdea}`);
    return fromIdea;
  }

  // 3. 常见安装路径
  const commonPaths = process.platform === 'win32'
    ? [
        'C:\\Apps\\Java',
        'D:\\Apps\\Java',
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Microsoft',
        'C:\\Program Files\\Zulu',
        'C:\\Program Files\\Amazon Corretto',
      ]
    : [
        '/usr/lib/jvm',
        '/Library/Java/JavaVirtualMachines',
      ];

  for (const base of commonPaths) {
    const found = pickBestInDir(base);
    if (found) {
      console.log(`✓ 找到 JDK: ${found}`);
      return found;
    }
  }

  return null;
}

function generateJRE() {
  console.log('=== 生成精简 JRE ===\n');

  // 查找 JDK
  const javaHome = findJavaHome();
  if (!javaHome) {
    console.error(`✗ 未找到 JDK (需要 JDK ${MIN_MAJOR}+，包含 jlink 工具)`);
    console.error('\n请安装 JDK 或设置 JAVA_HOME 环境变量');
    console.error('推荐下载: https://adoptium.net/');
    process.exit(1);
  }

  console.log(`JAVA_HOME: ${javaHome}`);

  // 检查并复制 JAR 文件
  const jarSource = path.join(__dirname, '..', 'gourd-ai-agent', 'target', 'gourd-ai-agent.jar');
  const jarDest = path.join(__dirname, 'build', 'extraResources', 'gourd-ai-agent.jar');

  if (fs.existsSync(jarSource)) {
    console.log(`✓ 找到 JAR: ${jarSource}`);
    const extraResourcesDir = path.dirname(jarDest);
    fs.mkdirSync(extraResourcesDir, { recursive: true });
    fs.copyFileSync(jarSource, jarDest);
    const sizeMB = (fs.statSync(jarDest).size / 1024 / 1024).toFixed(1);
    console.log(`✓ 复制 JAR: ${sizeMB} MB\n`);
  } else {
    console.log(`! JAR 不存在，跳过复制: ${jarSource}`);
    console.log('  提示：先运行 Maven 构建\n');
  }

  // 目标目录
  const jreDir = path.join(__dirname, 'build', 'extraResources', 'jre');

  // 删除旧的 JRE
  if (fs.existsSync(jreDir)) {
    console.log('→ 删除旧的 JRE...');
    fs.rmSync(jreDir, { recursive: true, force: true });
  }

  // 运行 jlink
  console.log('→ 运行 jlink 生成精简 JRE...');
  const jlink = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink');
  const jmods = path.join(javaHome, 'jmods');

  if (!fs.existsSync(jmods)) {
    console.error(`✗ jmods 目录不存在: ${jmods}`);
    console.error('  这可能是 JRE 而不是 JDK，请安装完整的 JDK');
    process.exit(1);
  }

  const modules = [
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
  ].join(',');

  const cmd = `"${jlink}" --module-path "${jmods}" --add-modules ${modules} --output "${jreDir}" --strip-debug --compress 2 --no-header-files --no-man-pages`;

  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
  } catch (err) {
    console.error('\n✗ jlink 失败');
    process.exit(1);
  }

  // 计算大小
  function getDirSize(dir) {
    let size = 0;
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += fs.statSync(filePath).size;
      }
    }
    return size;
  }

  const sizeMB = (getDirSize(jreDir) / 1024 / 1024).toFixed(1);
  console.log(`\n✓ JRE 生成完成: ${sizeMB} MB`);
  console.log(`  路径: ${jreDir}`);

  // 验证关键文件
  const javaExe = path.join(jreDir, 'bin',
    process.platform === 'win32' ? 'javaw.exe' : 'java');
  if (fs.existsSync(javaExe)) {
    console.log(`✓ java 可执行文件: ${javaExe}`);
  } else {
    console.error(`✗ 警告: java 可执行文件不存在: ${javaExe}`);
  }

  console.log('\n现在可以运行 npm run dev 或 npm run build:win 了');
}

generateJRE();
