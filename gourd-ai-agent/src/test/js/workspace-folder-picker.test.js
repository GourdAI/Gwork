'use strict';
/* 契约：「打开文件夹」浏览器主路径必须是 webkitdirectory 系统选择框，禁止 showDirectoryPicker。
 *
 * 背景（用户实测）：Chromium 在 showDirectoryPicker 之前会先弹「允许此网站查看和复制文件？」
 * 站点权限条，体验不可接受；而 <input webkitdirectory> 唤起的是同一个操作系统原生文件夹
 * 选择框且零权限提示。浏览器拿不到绝对路径，故指纹交同机后端 /web/chat/projects/locate 反查。
 *
 * 断言：
 * - app-workspace.js：pickSystemFolder 体内不得调用 window.showDirectoryPicker（注释提及允许）
 * - app-workspace.js：pickSystemFolder 的浏览器分支走 fallbackInputPicker
 * - app-workspace.js：fallbackInputPicker 建 webkitdirectory input 并 click 唤起系统框，
 *   change 后以「根目录名 + 含文件的子目录名」调 locateAndFinish
 * - app-workspace.js：collectDirFingerprint（File System Access 句柄遍历）已整体移除
 * - app-workspace.js：locateAndFinish 多候选仍渲染消歧列表、唯一候选直接登记选中
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..', '..', 'main', 'resources', 'static', 'js');
const ws = fs.readFileSync(path.join(ROOT, 'app-workspace.js'), 'utf8');

function sliceBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, '起始标记必须存在: ' + startMark);
  const e = src.indexOf(endMark, s + startMark.length);
  assert.ok(e > s, '结束标记必须存在: ' + endMark);
  return src.slice(s, e);
}

test('pickSystemFolder 不得调用 showDirectoryPicker（权限提示根因防回归）', () => {
  const fn = sliceBetween(ws, 'function pickSystemFolder(onPicked)', '/* 切换 chat 工作空间');
  assert.doesNotMatch(fn, /window\.showDirectoryPicker\s*\(/, 'showDirectoryPicker 会先弹站点权限条');
  assert.doesNotMatch(fn, /collectDirFingerprint/, '句柄指纹采集随 FS Access 路径一并移除');
  assert.match(fn, /fallbackInputPicker\(onPicked\)/, '浏览器分支必须走 webkitdirectory 选择框');
  assert.match(fn, /__GOURD_IPC__\.pickDirectory/, '桌面端 IPC 原生对话框仍是第一优先');
});

test('fallbackInputPicker 是系统原生选择框且零权限提示路径', () => {
  const fn = sliceBetween(ws, 'function fallbackInputPicker(onPicked)', '/* 渲染同名目录消歧列表');
  assert.match(fn, /webkitdirectory/, '必须用 webkitdirectory 唤起系统文件夹选择框');
  assert.match(fn, /input\.click\(\)/, '必须主动 click 唤起对话框');
  assert.match(fn, /locateAndFinish\(/, '选完必须走 locate 反查绝对路径');
  assert.match(fn, /webkitRelativePath/, '指纹来自相对路径分段');
});

test('collectDirFingerprint 已整体移除（无 File System Access 残留）', () => {
  assert.doesNotMatch(ws, /function collectDirFingerprint/);
  assert.doesNotMatch(ws, /handle\.values\(\)/, '句柄遍历不得残留');
});

test('locateAndFinish 分流语义保持：唯一直接选中、多候选消歧、零候选兜底', () => {
  const fn = sliceBetween(ws, 'function locateAndFinish(name, children, onPicked)', '/* 最终安全网');
  assert.match(fn, /candidates\.length === 1[\s\S]*onPicked\(candidates\[0\]\)/);
  assert.match(fn, /candidates\.length >= 2[\s\S]*renderCandidateList\(dd, candidates\)/);
  assert.match(fn, /finalFallback\(onPicked\)/);
});

/* ================= 桌面壳必须实现 pickDirectory（用户实测回归护栏） =================
 * 事故：前端第一优先调 __GOURD_IPC__.pickDirectory，但 Electron preload 与 Tauri 桥
 * 都没实现它 → 桌面端静默跌入 webkitdirectory 兜底，弹出「选择要上传的文件夹」
 * 「将 N 个文件上传到此网站？」两个浏览器语义弹框。故这里把「两个壳都实现」钉成契约：
 * 任一侧缺失，本组用例立即变红。 */

const REPO = path.join(__dirname, '..', '..', '..', '..');
function readRepo(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

test('Electron 壳：preload 暴露 pickDirectory 且主进程注册 pick-directory', () => {
  const preload = readRepo(path.join('gourd-ai-desktop', 'main', 'preload.js'));
  assert.match(preload, /pickDirectory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('pick-directory'\)/,
    'preload 必须暴露 pickDirectory 并 invoke pick-directory');
  const main = readRepo(path.join('gourd-ai-desktop', 'main', 'index.js'));
  assert.match(main, /ipcMain\.handle\('pick-directory'/, '主进程必须注册 pick-directory handler');
  assert.match(main, /dialog\.showOpenDialog/, '必须用 Electron 原生 dialog');
  assert.match(main, /openDirectory/, '对话框属性必须是选目录');
});

test('Tauri 壳：桥接层暴露 pickDirectory 且 Rust 侧命令/注册/授权齐备', () => {
  const bridge = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'ipc_bridge.rs'));
  assert.match(bridge, /pickDirectory:\s*function\s*\(\)\s*\{\s*return invoke\('pick_directory'\)/,
    'BRIDGE_JS 必须暴露 pickDirectory 并 invoke pick_directory');
  assert.match(bridge, /#\[tauri::command\][\s\S]*fn pick_directory/, 'Rust 侧必须实现 pick_directory 命令');
  assert.match(bridge, /blocking_pick_folder/, '命令必须用原生文件夹对话框 blocking API');
  const mainRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'src', 'main.rs'));
  assert.match(mainRs, /ipc_bridge::pick_directory/, 'main.rs 必须注册 pick_directory 命令');
  assert.match(mainRs, /tauri_plugin_dialog::init\(\)/, 'main.rs 必须注册 dialog 插件');
  const buildRs = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'build.rs'));
  assert.match(buildRs, /"pick_directory"/, 'build.rs COMMANDS 必须登记（否则远程源被 ACL 静默拒绝）');
  const caps = readRepo(path.join('gourd-ai-tauri', 'src-tauri', 'capabilities', 'default.json'));
  assert.match(caps, /"allow-pick-directory"/, 'capabilities 必须授权 allow-pick-directory');
});
