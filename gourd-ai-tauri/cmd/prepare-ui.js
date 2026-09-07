#!/usr/bin/env node
'use strict';

/**
 * prepare-ui.js —— 构建期把前端资源拷入 `gourd-ai-tauri/ui/`。
 *
 * 对齐 Electron 版 `gourd-ai-desktop/cmd/prepare-resources.js` 的 UI 部分。
 *
 * ## 为什么需要这一步
 * 前端唯一源目录是 `gourd-ai-agent/src/main/resources/static`（Maven 资源目录，
 * 同时会被打进 jar 供浏览器直连模式使用）。桌面端刻意绕开 jar，由内置 HTTP
 * 服务器从磁盘提供，以便界面外壳「秒开」，不等 JVM + Solon 启动。
 *
 * 运行期 `src/server.rs::get_ui_dir` 的解析顺序：
 *   1. 打包后：<resource_dir>/ui        ← 由 tauri.conf.json 的 bundle.resources 注入
 *   2. 开发态：向上回溯仓库根后的 gourd-ai-agent/src/main/resources/static
 *
 * 因此本脚本主要服务于**打包**：把 static/ 拷到 `ui/`，再由 bundler 收进包内。
 * 开发态即使 `ui/` 为空也能跑（走第 2 分支读源目录明文）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UI_SOURCE = path.resolve(
  ROOT,
  '..',
  'gourd-ai-agent',
  'src',
  'main',
  'resources',
  'static'
);
const UI_TARGET = path.join(ROOT, 'ui');

function fail(msg) {
  console.error(`[prepare-ui] ${msg}`);
  process.exit(1);
}

function main() {
  if (!fs.existsSync(UI_SOURCE)) {
    fail(`前端源目录不存在: ${UI_SOURCE}`);
  }
  if (!fs.existsSync(path.join(UI_SOURCE, 'index.html'))) {
    fail(`前端源目录缺少 index.html: ${UI_SOURCE}`);
  }

  // 清空目标目录（保留目录本身，避免 frontendDist 指向不存在的路径）
  if (fs.existsSync(UI_TARGET)) {
    for (const name of fs.readdirSync(UI_TARGET)) {
      if (name === '.gitkeep') continue;
      fs.rmSync(path.join(UI_TARGET, name), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(UI_TARGET, { recursive: true });
  }

  fs.cpSync(UI_SOURCE, UI_TARGET, { recursive: true });

  // 清理开发期 JVM 工作目录污染（与 Electron 版 prepare-resources.js 一致）
  for (const junk of ['.gwork', '.gourdai']) {
    const p = path.join(UI_TARGET, junk);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  const count = countFiles(UI_TARGET);
  console.log(`[prepare-ui] 前端资源已就绪: ${UI_TARGET} (${count} 个文件)`);
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n += 1;
  }
  return n;
}

main();
