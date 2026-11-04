'use strict';
/* 契约：远程主机指纹校验（2026-10-08 缺陷修复）——多算法 TOFU + 拒绝带指纹 + 忘记主机入口。
 *
 * 背景（真机缺陷）：服务器可同时挂多把不同算法的主机密钥（RSA/ECDSA/ED25519），
 * KEX 协商用哪把由协商决定。旧版 known_hosts 只记指纹不记算法：首连记 ED25519、
 * 重连协商到 RSA → 指纹必然不符 → 首连过的老主机被误报「主机密钥已更改」拒连。
 *
 * 锁定的关键行为：
 * 1. known_hosts 按「主机 + 算法」分条（verify/record 带 algorithm 参数；旧两段式
 *    行兼容为软匹配，不据此判 Changed）；remove 清该 host:port 全部记录。
 * 2. 指纹拒绝（同算法 Changed）时错误文案携带 host:port + 算法 + 新旧指纹，
 *    且以固定短语「主机密钥校验失败」开头。
 * 3. 前端凭该固定短语识别指纹拒绝，在连接失败日志区显示「忘记该主机」按钮；
 *    按钮调 remoteForgetHost → 成功后用相同参数重连（回到首连信任流程）。
 * 4. 识别锚两端一致：ssh.rs KeyRejection::message 开头 === app-remote.js
 *    KEY_REJECT_MARKER（错误串来自 Rust 不经 i18n，识别只能靠常量——两端漂移
 *    会让按钮静默消失，用户又回到手删 known_hosts 的老路）。
 * 5. IPC 链路完整：ipc_bridge remoteForgetHost → invoke remote_forget_host →
 *    main.rs 注册 → mod.rs 命令 → known_hosts::remove。
 * 6. i18n：forget_host_btn / forget_failed 12 语言包齐全。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

/* 仓库根：__dirname = gourd-ai-agent/src/test/js → 向上四级 */
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const STATIC = path.join(ROOT, 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const TAURI_SRC = path.join(ROOT, 'gourd-ai-tauri', 'src-tauri', 'src');

const remote = fs.readFileSync(path.join(STATIC, 'js', 'app-remote.js'), 'utf8');
const appCss = fs.readFileSync(path.join(STATIC, 'css', 'app.css'), 'utf8');
const ipcBridge = fs.readFileSync(path.join(TAURI_SRC, 'ipc_bridge.rs'), 'utf8');
const mainRs = fs.readFileSync(path.join(TAURI_SRC, 'main.rs'), 'utf8');
const modRs = fs.readFileSync(path.join(TAURI_SRC, 'remote', 'mod.rs'), 'utf8');
const sshRs = fs.readFileSync(path.join(TAURI_SRC, 'remote', 'ssh.rs'), 'utf8');
const khRs = fs.readFileSync(path.join(TAURI_SRC, 'remote', 'known_hosts.rs'), 'utf8');

function sliceBetween(src, startMark, endMark) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, '起始标记必须存在: ' + startMark);
  const e = src.indexOf(endMark, s + startMark.length);
  assert.ok(e > s, '结束标记必须存在: ' + endMark);
  return src.slice(s, e);
}

test('known_hosts：verify/record 按「主机+算法」分条（多算法 TOFU 的修复点）', () => {
  // verify/record 签名必须带 algorithm 参数（旧版只收指纹 → 跨算法误判）
  const verifySig = sliceBetween(khRs, 'pub fn verify(', 'pub fn record(');
  assert.match(verifySig, /algorithm: &str/, 'verify 必须收算法参数');
  assert.match(verifySig, /fingerprint: &str/, 'verify 必须收指纹参数');
  const recordSig = sliceBetween(khRs, 'pub fn record(', 'pub fn remove(');
  assert.match(recordSig, /algorithm: &str/, 'record 必须收算法参数');
  // 校验主体：算法不匹配的记录行直接跳过（不得参与 Changed 判定）
  assert.match(verifySig, /alg != algorithm/, '算法不同的记录行必须跳过');
  // 旧两段式行只软匹配：指纹不同不得判 Changed（那正是本缺陷的温床）
  assert.match(verifySig, /legacy_match/, '旧两段式行必须走软匹配路径');
});

test('known_hosts：remove 清该 host:port 全部记录且原子替换', () => {
  const removeSeg = sliceBetween(khRs, 'pub fn remove(', 'pub fn host_key(');
  assert.match(removeSeg, /removed \+= 1/, '必须统计删除行数');
  assert.match(removeSeg, /std::fs::rename/, '必须临时文件 + rename 原子替换（防崩溃清库）');
  assert.match(removeSeg, /return Ok\(0\)/, '无记录/文件不存在必须幂等返回 0');
});

test('ssh.rs：指纹拒绝详情携带 host/算法/新旧指纹，且以固定短语开头', () => {
  const msgSeg = sliceBetween(sshRs, 'pub fn message(&self) -> String', 'impl russh::client::Handler');
  for (const frag of ['self.host', 'self.port', 'self.algorithm', 'self.expected', 'self.fingerprint']) {
    assert.ok(msgSeg.includes(frag), '拒绝文案必须含 ' + frag);
  }
  // 固定开头短语（前端识别锚；拼接构造避免本断言字面量自匹配）
  const anchor = ['主机密钥', '校验失败'].join('');
  assert.ok(msgSeg.includes(anchor), 'message 必须含前端识别锚短语');
  assert.match(msgSeg, /starts_with|format!\(/, 'message 必须以该短语开头');
});

test('ssh.rs：connect 失败分支把 UnknownKey 映射为拒绝详情（不丢指纹）', () => {
  const errSeg = sliceBetween(sshRs, 'fn connect_error(', 'impl russh::client::Handler');
  assert.match(errSeg, /russh::Error::UnknownKey/, '必须识别 UnknownKey 变体');
  assert.match(errSeg, /rejection\.lock\(\)\.unwrap\(\)\.take\(\)/, '必须从共享状态取回拒绝详情');
  // 两条连接路径（直连/跳板）都经 connect_error 包装
  assert.match(sshRs, /connect_error\(e, "SSH 连接失败"/, '直连失败必须包装');
  assert.match(sshRs, /connect_error\(e, "经跳板机连接"/, '跳板失败必须包装');
});

test('识别锚两端一致：Rust message 开头 === 前端 KEY_REJECT_MARKER', () => {
  // 前端常量
  const m = remote.match(/var KEY_REJECT_MARKER = '([^']+)'/);
  assert.ok(m, 'app-remote.js 必须定义 KEY_REJECT_MARKER');
  const marker = m[1];
  // Rust 侧 message 的首个 format! 片段必须以该短语开头（拼接构造防自匹配）
  const anchor = ['"', marker].join('');
  assert.ok(sshRs.includes(anchor + '（'), 'ssh.rs message 必须以「' + marker + '」开头（含后续括号）');
  // 前端失败分支确实用该常量识别并给按钮
  const failSeg = sliceBetween(remote, 'logLine(GourdI18n.t(\'remote.connect_failed\'));', 'function doDisconnect');
  assert.ok(failSeg.includes('KEY_REJECT_MARKER'), '失败分支必须用识别锚判定');
  assert.match(failSeg, /appendForgetHostAction\(cfg\)/, '命中锚必须追加忘记按钮');
  assert.match(failSeg, /cfg\.channel !== 'wsl'/, 'wsl 通道无主机密钥校验，不得出现该按钮');
});

test('前端：忘记按钮调 remoteForgetHost，成功后同参数重连，失败可重试', () => {
  const seg = sliceBetween(remote, 'function appendForgetHostAction(', 'function doConnect(');
  assert.match(seg, /ipc\.remoteForgetHost\(cfg\.host, cfg\.port \|\| 22\)/, '必须带 host+port 调 IPC');
  assert.match(seg, /doConnect\(cfg\)/, '清库成功后必须用相同参数重连（回到首连信任）');
  assert.match(seg, /btn\.disabled = false/, '清库失败必须恢复按钮可重试');
  assert.match(seg, /remote\.forget_failed/, '失败必须提示（不得静默）');
  // 按钮挂进日志区（用户看得见失败上下文）
  assert.match(seg, /remoteConnectLog/, '按钮必须追加进连接日志区');
});

test('IPC 链路完整：bridge → invoke → main 注册 → 命令 → remove', () => {
  assert.match(ipcBridge, /remoteForgetHost: function \(host, port\)/, 'ipc_bridge 必须暴露 remoteForgetHost');
  assert.match(ipcBridge, /invoke\('remote_forget_host'/, '必须 invoke remote_forget_host');
  assert.match(mainRs, /remote::remote_forget_host/, 'main.rs 必须注册命令');
  const cmdSeg = sliceBetween(modRs, 'pub async fn remote_forget_host(', '/// 手动重推模型镜像');
  assert.match(cmdSeg, /known_hosts::remove/, '命令必须落到 known_hosts::remove');
  assert.match(cmdSeg, /spawn_blocking/, '文件 IO 必须出异步运行时');
  assert.match(cmdSeg, /"removed"/, '必须回传删除条数（幂等语义）');
});

test('i18n：forget_host_btn / forget_failed 12 语言包齐全', () => {
  const dir = path.join(STATIC, 'locales');
  const langs = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(langs.length, 12, '必须 12 个语言包');
  for (const lang of langs) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, lang), 'utf8'));
    assert.ok(data.remote && data.remote.forget_host_btn, lang + ' 缺 remote.forget_host_btn');
    assert.ok(data.remote && data.remote.forget_failed, lang + ' 缺 remote.forget_failed');
    assert.ok(String(data.remote.forget_host_btn).trim().length > 0, lang + ' forget_host_btn 为空');
  }
});

test('CSS：忘记按钮样式存在（日志区内的次级按钮）', () => {
  assert.match(appCss, /\.remote-forget-btn \{/, '必须有 .remote-forget-btn 基础样式');
  assert.match(appCss, /\.remote-forget-btn:disabled/, '禁用态必须有样式（清库进行中）');
});
