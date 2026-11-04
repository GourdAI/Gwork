#!/usr/bin/env node
/* ============================================================
   构建前置：根据「是否具备完整签名条件」决定本次构建是否产出更新包。

   为什么需要这一步：
     bundle.createUpdaterArtifacts = true 时，tauri-cli 在**打包完成之后**才校验
     私钥，缺 TAURI_SIGNING_PRIVATE_KEY 会以
       "A public key has been found, but no private key."
     非零退出 —— 安装包其实已经生成，但整条命令算失败。任何未配置密钥的环境
     （本地开发、Fork、密钥配置前的 CI）都会撞上，而这些场景只想要一个能装的包。

   策略（与 main.rs 的 fail-safe 同一思路：宁可关掉更新，不可炸掉流程）：
     ① 公钥已替换 + 私钥存在 → 空 overlay，保持 createUpdaterArtifacts=true，产出 .sig
     ② 其余任意一项缺失       → overlay 置 createUpdaterArtifacts=false 并把
                                plugins.updater 置 null（RFC 7396 中 null = 删除该键），
                                只出安装包；客户端侧 main.rs 因 pubkey 不可用而
                                不注册插件，updater 跑 Mode::None，自动更新静默关闭。

   【非破坏性】本脚本**不修改** tauri.conf.json，只生成一份 overlay 配置，由
   `tauri build -c <overlay>` 合并。早期版本曾就地改写 tauri.conf.json，风险是
   降级分支会连同 plugins.updater 一起删掉真实 pubkey —— 而该公钥必须长期入库
   （它要编译进 app 才能校验更新），被静默清空后极难发现。

   用法：node cmd/configure-updater.js
   产出：src-tauri/updater.generated.conf.json（生成物，不入库）
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = 'REPLACE_WITH_TAURI_PUBLIC_KEY';
const confPath = path.resolve(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const outPath = path.resolve(__dirname, '..', 'src-tauri', 'updater.generated.conf.json');

const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));

const pubkey = ((conf.plugins || {}).updater || {}).pubkey || '';
const hasPubkey = pubkey.trim() !== '' && pubkey.trim() !== PLACEHOLDER;

// 私钥可以是「密钥内容」也可以是「密钥文件路径」（tauri-cli 先按路径试，
// 不存在则当作内容）。这里两种形态都认，但路径形态要真的存在才算数 ——
// 指向一个不存在的路径会被 CLI 当成密钥内容，最终报解码失败而非缺失。
const rawPriv = (process.env.TAURI_SIGNING_PRIVATE_KEY || '').trim();
let hasPrivkey = rawPriv !== '';
if (hasPrivkey && !rawPriv.includes('\n') && rawPriv.length < 4096) {
  // 看着像路径（单行、不长）时，若确实是个路径写法但文件不存在，直接判缺失
  const looksLikePath = /[\\/]/.test(rawPriv) || /\.(key|txt|pem)$/i.test(rawPriv);
  if (looksLikePath && !fs.existsSync(rawPriv)) {
    console.error('[updater] TAURI_SIGNING_PRIVATE_KEY 看起来是文件路径但该文件不存在: ' + rawPriv);
    hasPrivkey = false;
  }
}

if (hasPubkey && hasPrivkey) {
  // 空 overlay：合并后等价于原配置，createUpdaterArtifacts 保持 true
  fs.writeFileSync(outPath, '{}\n', 'utf8');
  console.log('[updater] 签名条件完整 → 本次构建产出更新包 + .sig');
  process.exit(0);
}

const reason = !hasPubkey
  ? 'tauri.conf.json 的 plugins.updater.pubkey 仍是占位符（需先 `tauri signer generate`）'
  : '环境变量 TAURI_SIGNING_PRIVATE_KEY 未设置或指向的文件不存在';

fs.writeFileSync(
  outPath,
  JSON.stringify({ bundle: { createUpdaterArtifacts: false }, plugins: { updater: null } }, null, 2) + '\n',
  'utf8'
);

console.log('[updater] 自动更新已禁用：' + reason);
console.log('[updater] 本次仅产出安装包，不产出 .sig / latest.json。');
