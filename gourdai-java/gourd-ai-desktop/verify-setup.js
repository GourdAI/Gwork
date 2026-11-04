#!/usr/bin/env node
'use strict';
/**
 * verify-setup.js - 验证 GWork Desktop 配置
 */

const path = require('path');
const fs = require('fs');

console.log('=== GWork Desktop 配置验证 ===\n');

let allOk = true;

// 1. 检查 JRE
const jreDir = path.join(__dirname, 'build', 'extraResources', 'jre');
const javaExe = path.join(jreDir, 'bin',
  process.platform === 'win32' ? 'javaw.exe' : 'java');

if (fs.existsSync(javaExe)) {
  const stats = fs.statSync(jreDir);
  console.log('✓ JRE 已配置');
  console.log(`  路径: ${jreDir}`);
  console.log(`  可执行文件: ${javaExe}`);

  // 计算 JRE 大小
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
  console.log(`  大小: ${sizeMB} MB\n`);
} else {
  console.log('✗ JRE 未配置');
  console.log(`  预期路径: ${javaExe}`);
  console.log('  解决方法: npm run generate-jre\n');
  allOk = false;
}

// 2. 检查 JAR
const jarPath = path.join(__dirname, 'build', 'extraResources', 'gourd-ai-agent.jar');
if (fs.existsSync(jarPath)) {
  const sizeMB = (fs.statSync(jarPath).size / 1024 / 1024).toFixed(1);
  console.log('✓ JAR 文件已配置');
  console.log(`  路径: ${jarPath}`);
  console.log(`  大小: ${sizeMB} MB\n`);
} else {
  console.log('✗ JAR 文件未配置');
  console.log(`  预期路径: ${jarPath}`);
  console.log('  解决方法: npm run generate-jre\n');
  allOk = false;
}

// 3. 检查 backend.js 逻辑
const backendJs = path.join(__dirname, 'main', 'backend.js');
if (fs.existsSync(backendJs)) {
  const content = fs.readFileSync(backendJs, 'utf-8');
  const hasBundledJreLogic = content.includes('bundledJava') && content.includes('jre/bin');
  if (hasBundledJreLogic) {
    console.log('✓ backend.js 支持内置 JRE');
    console.log('  查找顺序: 内置 JRE → JAVA_EXEC → JAVA_HOME → PATH\n');
  } else {
    console.log('✗ backend.js 不支持内置 JRE');
    console.log('  需要检查 findJava() 函数\n');
    allOk = false;
  }
}

// 4. 总结
console.log('='.repeat(50));
if (allOk) {
  console.log('✅ 所有检查通过！');
  console.log('\n可以运行以下命令:');
  console.log('  npm run dev          # 开发模式');
  console.log('  npm run build:win    # 打包 Windows 安装程序');
  console.log('\n用户安装后无需安装 Java，应用会自动使用内置 JRE。');
} else {
  console.log('❌ 发现配置问题，请按照上述提示修复。');
  console.log('\n快速修复:');
  console.log('  npm run generate-jre');
  process.exit(1);
}
