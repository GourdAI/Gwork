/* 登录态翻转链路契约（用户 11-27 报障「服务端 tokens 失效侧栏仍显示登录；
   侧栏登录后任务对话框看不到官方模型，必须进出模型配置页才恢复」）。

   两个真因的护栏都落在前端接线上，CI（test:js）必须锁死：
   1. 假登录态：本地 status() 只看本地 access token 过期时间，服务端已撤销的
      会话在壳的 keeper 清理落地前一直显示「已登录」。修法 = app-account 的
      周期性服务端校验（authSelf 真发鉴权请求——authRefresh 对未到期 token
      本地短路不发网络，不能用作校验通道；terminal 时壳已 mark_session_dead
      清本地，回拉 authStatus 同帧翻态）+ 登录态翻转统一派发 gwork:auth-changed。
   2. 官方模型不展示：聊天页模型列表只在「打开页面 / 关闭模型设置页」时重载，
      侧栏登录成功后没有任何重载触发点。修法 = app-history 监听
      gwork:auth-changed → reloadModels()；app-model-settings 在「壳已登录但
      内核官方凭据未就绪」时补一次 authOfficialRefresh 自愈。

   断言全部先剥 JS 注释（根因文案写在注释里，不剥会喂饱 includes 断言）。
   派发点唯一性用计数锁：app-account.js 里 trigger('gwork:auth-changed')
   只允许出现在 notifyAuthChanged 一处，onSubmit/onLogout 手工派发属回归。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* JS 注释剥离：字符串 / 模板串 / 行注释 / 块注释四态。模板串里的 ${} 嵌套
   不展开（本文件的断言目标行不含模板插值）。 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  let quote = null;   // ' " `
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++; continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; } else { i++; }
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { if (n !== undefined) { out += n; i += 2; } else { i++; } continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

const account = stripJsComments(read('ui/js/app-account.js'));
const history = stripJsComments(read('ui/js/app-history.js'));
const settings = stripJsComments(read('ui/js/app-model-settings.js'));

test('account: 登录态翻转由 applyStatus 统一派发，且只此一处', () => {
  assert.match(account, /statusInitialized/, '首帧标记必须存在（启动恢复不派发）');
  assert.match(
    account,
    /statusInitialized && prev !== state\.signed_in/,
    'applyStatus 必须在翻转时（且非首帧）派发事件');
  assert.match(account, /function notifyAuthChanged\(\)/, '派发必须收敛到单一函数');
  const triggers = account.match(/trigger\('gwork:auth-changed'\)/g) || [];
  assert.equal(triggers.length, 1,
    'trigger 只允许 notifyAuthChanged 一处；onSubmit/onLogout 手工派发属回归');
});

test('account: 已登录时周期性向服务端校验会话，terminal 后回拉状态翻态', () => {
  assert.match(account, /function verifyAgainstServer\(\)/, '服务端校验函数必须存在');
  /* 【必须 authSelf 而非 authRefresh】壳的 refresh() 对未到期 access token
     本地短路（REFRESH_LEAD_SECS 分支）不发网络请求——服务端撤销后 JWT 通常
     还有最长 15 分钟有效期，authRefresh 校验恰在假登录窗口里全程空转。
     authSelf → authorized_get('/api/user/self') 每次真发请求，terminal 判死
     由壳的 mark_session_dead 收口。用 authRefresh 做校验属回归。 */
  assert.match(account, /i\.authSelf\(\)\.then/, '校验必须借 authSelf 真发鉴权请求');
  assert.doesNotMatch(account, /i\.authRefresh\(\)/,
    'authRefresh 有本地短路，不得用作服务端校验通道');
  assert.match(account, /if \(s && s\.signed_in\) verifyAgainstServer\(\)/,
    'refreshStatus 拿到「本地已登录」才值得问服务端');
  assert.match(account, /i\.authStatus\(\)\.then\(applyStatus/,
    '校验失败后必须回拉 authStatus：壳已 mark_session_dead 时这一帧翻成未登录');
  assert.match(account, /VERIFY_MIN_INTERVAL_MS = 5 \* 60 \* 1000/,
    '校验必须节流（5 分钟），不能每 60s 轮询都打后台');
  assert.match(account, /verifying/, '并发校验必须去重');
});

test('history: 登录态翻转后任务对话框模型下拉同帧重载官方模型', () => {
  assert.match(
    history,
    /on\('gwork:auth-changed'[\s\S]{0,240}reloadModels\(\)/,
    '聊天页必须监听 gwork:auth-changed 并 reloadModels，' +
    '否则侧栏登录后官方模型要等进出模型配置页才出现');
  assert.match(history, /window\.reloadModels = reloadModels/, '导出契约保留');
});

test('model-settings: 壳已登录但官方源未就绪时补一次强制重取自愈', () => {
  assert.match(settings, /function maybeSelfHealOfficial\(\)/, '自愈函数必须存在');
  assert.match(settings, /ipc\.authOfficialRefresh\(\)/, '自愈必须走 authOfficialRefresh');
  assert.match(settings, /loadOfficialState\(maybeSelfHealOfficial\)/,
    'auth-changed 事件必须带自愈回调');
  assert.match(settings, /if \(!shellSignedIn \|\| officialState\.signedIn\) return/,
    'prime 成功过或未登录都不得重复打后台');
  /* 后端未就绪时 /web/settings/official/status 的 error 分支会把 officialState
     伪造成 signedIn=false——不设门闸会对没起来的内核白发强制重取。 */
  assert.match(settings, /__whenBackendReady/,
    '自愈必须过 __whenBackendReady 门闸（与 init 预载同口径）');
});

test('双壳镜像：账号/聊天/模型设置三份 JS 与 Java 冻结壳副本逐字节一致', () => {
  for (const f of ['app-history.js', 'app-account.js', 'app-model-settings.js']) {
    const a = read('ui/js/' + f);
    const b = fs.readFileSync(path.join(ROOT, '..', '..', 'gourd-ai-tauri', 'ui', 'js', f), 'utf8');
    assert.equal(a, b, 'gourd-ai-tauri/ui/js/' + f + ' 必须同步（双壳镜像契约）');
  }
});
