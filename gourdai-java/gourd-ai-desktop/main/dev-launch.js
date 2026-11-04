'use strict';
/**
 * dev-launch.js - 开发模式启动辅助脚本
 *
 * 自动探测 JAVA_HOME，然后启动 Electron。
 * 用法：node main/dev-launch.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Windows 下将控制台代码页切换到 UTF-8，避免中文日志乱码
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch (e) { /* ignore */ }
}

function findJavaHome() {
  // 1. 环境变量 JAVA_HOME
  if (process.env.JAVA_HOME) {
    return process.env.JAVA_HOME;
  }

  // 2. IntelliJ 下载的 JDK（~/.jdks/）
  const jdksDir = path.join(os.homedir(), '.jdks');
  if (fs.existsSync(jdksDir)) {
    const entries = fs.readdirSync(jdksDir).sort().reverse(); // 取最新版本
    for (const entry of entries) {
      const javaExe = path.join(jdksDir, entry, 'bin',
        process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaExe)) {
        console.log(`[dev] 自动探测到 JDK: ${path.join(jdksDir, entry)}`);
        return path.join(jdksDir, entry);
      }
    }
  }

  // 3. 常见安装路径
  const commonPaths = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Eclipse Adoptium',
        'C:\\Program Files\\Java',
        'C:\\Program Files\\Microsoft',
      ]
    : [
        '/usr/lib/jvm',
        '/Library/Java/JavaVirtualMachines',
      ];

  for (const base of commonPaths) {
    if (!fs.existsSync(base)) continue;
    const entries = fs.readdirSync(base).sort().reverse();
    for (const entry of entries) {
      const javaExe = path.join(base, entry, 'bin',
        process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaExe)) {
        console.log(`[dev] 自动探测到 JDK: ${path.join(base, entry)}`);
        return path.join(base, entry);
      }
    }
  }

  return null;
}

const javaHome = findJavaHome();
if (!javaHome) {
  console.error('[dev] 未找到 Java 环境，请设置 JAVA_HOME 环境变量');
  process.exit(1);
}

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  NODE_ENV: 'development',
};
const electronExe = require('electron');
const projectRoot = path.join(__dirname, '..');

console.log(`[dev] JAVA_HOME=${javaHome}`);
console.log(`[dev] electron: ${electronExe}`);
console.log(`[dev] 启动 Electron...`);

const proc = spawn(electronExe, [projectRoot], {
  env,
  stdio: 'inherit',
  shell: false,
});

proc.on('exit', (code) => process.exit(code || 0));
