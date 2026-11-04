'use strict';

const os = require('os');

/**
 * OS 用户主目录。Windows 与 Unix 的变量优先级必须固定且全局唯一：
 * 同时存在 USERPROFILE 与 HOME 的环境（Git Bash、WSL 互通、CI）下，若不同调用方
 * 读取顺序不一致，会出现启动器写到 A、后端却读 B 的分叉。
 */
function resolveUserHome(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? (env.USERPROFILE || os.homedir())
    : (env.HOME || os.homedir());
}

/**
 * 运行时数据<b>基目录</b>，即 Java 侧 -Dgwork.home 的取值语义。
 *
 * <b>不含</b> `.gwork` 子目录：AgentFlags.getHarnessBase() 拿到后自己再拼
 * harnessHome=".gwork"，Node 侧绝不能预先拼，否则全局区会嵌套成 .gwork/.gwork，
 * 表现为重装后「配置被清空」（2026-08-08 复发事故的根因）。
 *
 * 该基目录刻意与打包方式、平台无关，一律是 OS 用户主目录；安装资源目录只用于
 * 定位内置 JRE/JAR 以及作为迁移来源。
 */
function getRuntimeHomeDirFor({ userHome } = {}) {
  if (!userHome || typeof userHome !== 'string') {
    // 静默返回 undefined 会让下游拼出 "undefined/.gwork"，必须直接暴露。
    throw new TypeError('getRuntimeHomeDirFor: userHome is required');
  }
  return userHome;
}

module.exports = { getRuntimeHomeDirFor, resolveUserHome };
