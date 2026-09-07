'use strict';

/**
 * desktop-log.js —— Electron **主进程**日志落盘（不是后端 jar 的日志）
 *
 * 为什么必须有：后端启动失败时，唯一的诊断现场是主进程的 console
 * （端口分配、findJava/findJar 探测明细、探针返回的状态码、子进程退出码）。
 * 但主进程 console 只写到启动它的终端 —— Windows 上 GWork.exe 由资源管理器/
 * NSIS 拉起，根本没有终端，这些输出 100% 丢失。叠加后端 jar 侧
 * `-Dsolon.logging.appender.file.level=ERROR`，一次"接口全不通"的故障
 * 在磁盘上留不下任何线索（2026-09-06 排查该问题时正是卡在这里）。
 *
 * 设计约束：
 * - **绝不阻断启动**：任何写盘失败都降级为「只走 console」，且只告警一次。
 *   日志是排障工具，不能变成新的故障源。
 * - 与 backend.js 的 `gwork-desktop-server.log`（子进程 stdout/stderr）分开，
 *   本文件只写主进程侧的 `gwork-desktop-main.log`，两份日志不要互相覆盖。
 * - 体积自律：单文件上限 MAX_BYTES，超限滚动一份 .1（旧 .1 丢弃）。
 *   主进程日志量本就很低，滚动只为兜住异常刷屏。
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { getRuntimeHomeDirFor, resolveUserHome } = require('./runtime-paths');

/** 单份日志上限（5MB），超限滚动为 .1。 */
const MAX_BYTES = 5 * 1024 * 1024;

const LOG_BASENAME = 'gwork-desktop-main.log';

let logFilePath = '';
let stream = null;
let installError = '';
let writeWarned = false;
let seq = 0;

/**
 * 主进程日志路径：<基目录>/.gwork/logs/gwork-desktop-main.log
 * 与后端日志同目录，便于一次抓全。基目录语义见 runtime-paths（不含 .gwork）。
 */
function getMainLogPath() {
  const base = getRuntimeHomeDirFor({ userHome: resolveUserHome() });
  return path.join(base, '.gwork', 'logs', LOG_BASENAME);
}

/** ISO 风格本地时间 + 毫秒，便于与后端日志对时。 */
function stamp(ts) {
  const d = new Date(ts);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1, 2)}-${p(d.getDate(), 2)} `
    + `${p(d.getHours(), 2)}:${p(d.getMinutes(), 2)}:${p(d.getSeconds(), 2)}.${p(d.getMilliseconds(), 3)}`;
}

function rotateIfNeeded() {
  try {
    if (!fs.existsSync(logFilePath)) return;
    const st = fs.statSync(logFilePath);
    if (st.size < MAX_BYTES) return;
    const bak = `${logFilePath}.1`;
    try { fs.rmSync(bak, { force: true }); } catch (e) { /* ignore */ }
    fs.renameSync(logFilePath, bak);
  } catch (e) {
    // 滚动失败不影响继续写入当前文件
  }
}

function openStream() {
  if (stream) return stream;
  try {
    logFilePath = getMainLogPath();
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    rotateIfNeeded();
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    stream.on('error', (e) => {
      // 句柄错误（磁盘满/权限）后不再尝试写，避免每次 log 都触发一次错误
      installError = `日志写入失败: ${e && e.message}`;
      try { stream.destroy(); } catch (err) { /* ignore */ }
      stream = null;
    });
    return stream;
  } catch (e) {
    installError = `日志初始化失败: ${e && e.message}`;
    stream = null;
    return null;
  }
}

/** 把 console 风格的多个参数拼成一行（对象走 util.inspect，避免 [object Object]）。 */
function format(args) {
  let out = '';
  for (const a of args) {
    if (typeof a === 'string') out += a;
    else if (a instanceof Error) out += (a.stack || a.message);
    else out += util.inspect(a, { depth: 4, breakLength: Infinity, colors: false });
    out += ' ';
  }
  return out.trimEnd();
}

function writeLine(level, text) {
  try {
    const s = openStream();
    if (!s) return;
    const line = `${stamp(Date.now())} [${level}] ${text}\n`;
    s.write(line);
    seq += 1;
    // 每 512 行检查一次体积，避免每条日志都 stat
    if (seq % 512 === 0) rotateIfNeeded();
  } catch (e) {
    if (!writeWarned) {
      writeWarned = true;
      try { console.warn('[gourd-ai-desktop] 主进程日志写入异常（已降级为仅控制台）:', e && e.message); } catch (err) { /* ignore */ }
    }
  }
}

const original = {};

/**
 * 安装 console tee。幂等：重复调用只生效一次。
 * 保留原生输出，开发态在终端里看到的与改动前完全一致。
 */
function install() {
  if (original.log) return getMainLogPath();

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    original[level] = typeof orig === 'function' ? orig.bind(console) : () => {};
    console[level] = function tee(...args) {
      writeLine(level.toUpperCase(), format(args));
      try { original[level](...args); } catch (e) { /* ignore */ }
    };
  }

  // 'uncaughtExceptionMonitor' 不会改变未捕获异常的默认处理（不像
  // process.on('uncaughtException') 会把异常吞掉），因此能安全地补上崩溃现场
  // 而不引入新的退出语义差异。
  //
  // 【修正】旧写法是 `typeof process.errorMonitor === 'function'`，但 process 上根本
  // 没有 errorMonitor 这个方法（实测 Node v24 下为 undefined；errorMonitor 是
  // require('events').errorMonitor，且是个 Symbol）——条件恒为假，崩溃现场从未落盘，
  // 而这正是本次改造最想抳住的那一类现场。
  try {
    process.on('uncaughtExceptionMonitor', (err) => {
      writeLine('FATAL', `未捕获异常: ${(err && (err.stack || err.message)) || err}`);
    });
  } catch (e) { /* 老版本 Node：跳过，不影响启动 */ }

  process.on('unhandledRejection', (reason) => {
    writeLine('ERROR', `未处理的 Promise 拒绝: ${reason instanceof Error ? (reason.stack || reason.message) : util.inspect(reason)}`);
  });

  return getMainLogPath();
}

/**
 * 打一条带分隔线的结构化报告（启动期资源解析、端口、探针结果等）。
 * 排障时一眼能定位"本次启动到底看到了哪些路径"。
 */
function report(title, lines) {
  const body = (Array.isArray(lines) ? lines : [lines]).map((l) => `  ${l}`).join('\n');
  writeLine('INFO', `──── ${title} ────\n${body}`);
  try { console.log(`──── ${title} ────\n${body}`); } catch (e) { /* ignore */ }
}

/** 日志文件路径（可能尚未创建）；失败时返回空串，供 UI 展示"日志不可用"。 */
function currentLogPath() {
  try {
    return logFilePath || getMainLogPath();
  } catch (e) {
    return '';
  }
}

/** 初始化/写入失败原因（空串表示正常），供后端状态详情一并上报前端。 */
function getInstallError() {
  return installError;
}

module.exports = {
  install,
  report,
  writeLine,
  getMainLogPath,
  currentLogPath,
  getInstallError,
  // 供单测使用
  format,
  stamp,
};
