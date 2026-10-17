'use strict';
/*
 * 任务执行会话「运行参数提示条」契约测试。
 *
 * 背景（2026-10-16）：定时任务的模型/思考/上下文/权限是 transient 的，仅为任务自动执行生效，
 * 刻意不写入会话上下文（避免污染用户前台选择）。执行会话的 composer 展示的是会话自己的值，
 * 用户会误判「任务参数没生效/对不上」。修复方案：打开执行对话时在会话顶部显示任务运行参数提示条。
 *
 * 锁定内容：
 *   1. chat.html 含 banner 宿主（static 与 tauri/ui 镜像一致）；
 *   2. app-base.js 提供 setLoopRunBanner / renderLoopRunBanner / clearLoopRunBanner 并与
 *      setActiveSession 挂钩（切会话重建/隐藏），标题含任务名；
 *   3. 恢复链路（2026-10-17 方案A）：app-history.js refreshSessionModel 经
 *      /web/chat/loop-run 取证端点恢复提示条（刷新后/任意入口都能恢复，任务被删也不影响）；
 *      app-automation.js 不再反查任务定义注入（定义值 ≠ 本轮实际生效值，且任务可能已删）；
 *   4. 后端 WebStreamBuilder 轮首写/清取证键 _loop_run，WebController 提供 loop-run 端点；
 *   5. app.css 含样式；12 语言包含 6 个新键且非空。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const moduleRoot = path.resolve(__dirname, '..', '..', '..');
const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');

test('chat.html 含运行参数提示条宿主（static 与镜像一致）', () => {
  const src = read(path.join(staticRoot, 'chat.html'));
  assert.ok(src.indexOf('id="loopRunBanner"') >= 0, 'static/chat.html 缺少 #loopRunBanner 宿主');
  assert.ok(src.indexOf('loop-run-banner') >= 0, '缺少 .loop-run-banner 样式类标记');

  const mirror = read(path.join(mirrorRoot, 'chat.html'));
  assert.equal(mirror, src, 'gourd-ai-tauri/ui 副本已与 static 源不同步，请运行 node gourd-ai-tauri/cmd/prepare-ui.js');
});

test('app-base.js：banner 三函数导出 + setActiveSession 挂钩 + 标题含任务名', () => {
  const js = read(path.join(staticRoot, 'js', 'app-base.js'));
  assert.ok(js.indexOf('function setLoopRunBanner(') >= 0, '缺少 setLoopRunBanner 定义');
  assert.ok(js.indexOf('function renderLoopRunBanner(') >= 0, '缺少 renderLoopRunBanner 定义');
  assert.ok(js.indexOf('function clearLoopRunBanner(') >= 0, '缺少 clearLoopRunBanner 定义');
  assert.ok(js.indexOf('window.setLoopRunBanner = setLoopRunBanner') >= 0, 'setLoopRunBanner 未导出到 window');
  assert.ok(js.indexOf('renderLoopRunBanner()') >= 0, 'setActiveSession 未调用 renderLoopRunBanner（切会话需重建/隐藏提示条）');
  assert.ok(js.indexOf('loopRunBannerBySession') >= 0, '缺少按会话缓存的存储（切走再切回要能恢复）');
  assert.ok(js.indexOf('info.name') >= 0, '提示条标题必须展示取证携带的任务名');
  // 字段契约（2026-10-17 review 实锤缺陷）：取证端点输出键是 model，前端曾读 modelName（旧注入路径残留名）
  // 导致模型栏恒显「默认模型」。双向钉死：前端必须读 info.model，且不得再引用 info.modelName。
  assert.ok(js.indexOf('info.model ||') >= 0, '提示条模型栏必须读取证端点输出键 info.model');
  assert.ok(js.indexOf('info.modelName') < 0, 'modelName 是旧注入路径残留字段名，取证端点不返回该键');
});

test('app-history.js：refreshSessionModel 经 loop-run 取证端点恢复提示条', () => {
  const js = read(path.join(staticRoot, 'js', 'app-history.js'));
  assert.ok(js.indexOf('function restoreLoopRunBanner(') >= 0, '缺少 restoreLoopRunBanner 定义');
  assert.ok(js.indexOf('/web/chat/loop-run') >= 0, '必须请求取证端点（刷新后/任意入口恢复的唯一路径）');
  assert.ok(js.indexOf('window.setLoopRunBanner(sessionId, info)') >= 0, '取证命中必须重建提示条');
  assert.ok(js.indexOf('window.clearLoopRunBanner(sessionId)') >= 0, '无取证必须清除提示条（会话恢复手动对话后不误导）');
  assert.ok(js.indexOf('restoreLoopRunBanner(sessionId)') >= 0, 'refreshSessionModel 成功回调必须调用恢复函数');
});

test('app-automation.js：查看执行对话不再反查任务定义注入 banner', () => {
  const js = read(path.join(staticRoot, 'js', 'app-automation.js'));
  // 旧链路缺陷：任务被删除后 loop/get 返空 → 提示条永远不出现（2026-10-17 用户实锤场景）；
  // 且定义值 ≠ 本轮实际生效值。恢复统一改走取证端点。
  assert.ok(js.indexOf('window.setLoopRunBanner(') < 0, 'automation 不得再注入任务定义参数到 banner');
  assert.ok(js.indexOf('window.openSessionById(sessId, sessLabel, sessRoot);') >= 0, 'session 动作应直接打开执行会话');
});

test('后端：取证键轮首写/清 + loop-run 端点存在', () => {
  const engine = read(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'gourdai', 'harness', 'HarnessEngine.java'));
  assert.ok(engine.indexOf('CTX_LOOP_RUN = "_loop_run"') >= 0, '缺少会话级取证键常量');
  const builder = read(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebStreamBuilder.java'));
  assert.ok(builder.indexOf('recordLoopRunEvidence(') >= 0, 'buildTurnFlux 轮首必须写/清取证标记');
  assert.ok(builder.indexOf('String loopRunLabel') >= 0, 'buildStreamFlux 必须接收 loopRunLabel');
  const controller = read(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebController.java'));
  assert.ok(controller.indexOf('@Mapping("/web/chat/loop-run")') >= 0, '缺少取证读取端点');
  // 单一数据源（2026-10-17 review 修订）：getSession 永不返 null，快照兜底/旧快照派生是不可达死代码，
  // 且任意 sessionId 的 GET 会物化幽灵会话——已删；端点必须显式拒绝空 sessionId
  assert.ok(controller.indexOf('sessionId.isEmpty()') >= 0, 'loop-run 端点必须拒绝空 sessionId（防物化幽灵会话）');
  assert.ok(controller.indexOf('readAllBytes(snapshot') < 0,
    'loop-run 不得保留不可达的快照文件兜底路径（getSession 永不返 null，该路径是死代码且会物化幽灵会话）');
  const gate = read(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebGate.java'));
  assert.ok(gate.indexOf('accessModeOverride, loopRunLabel)') >= 0, 'startSyncRun 必须透传 loopRunLabel 到 buildStreamFlux');
  // resume 链路（2026-10-17 实锤：同一 run 内挂起轮 qwen、恢复轮 gpt-6-luna）：
  // 恢复轮必须按取证还原任务级 override，否则 Loop 任务被 ask_user/HITL 挂起后恢复即换回会话旧模型
  assert.ok(gate.indexOf('loopResumeEvidence(session)') >= 0, '恢复轮必须读会话取证标记');
  assert.ok(gate.indexOf('Map<String, Object> loopResume)') >= 0, 'performAgentTaskAsync 必须支持 loopResume 重载');
  const resumeCalls = (gate.match(/performAgentTaskAsync\(session, sessionCwd, (null|Prompt\.of\(\)), selectedModel, agentName, accessMode, loopResumeEvidence\(session\)\)/g) || []).length;
  assert.ok(resumeCalls >= 3, 'HITL/问答/中断续跑三条恢复路径都必须传取证（实际 ' + resumeCalls + '）');
  assert.ok(gate.indexOf('Prompt.of(answerText), selectedModel, agentName, accessMode, null)') >= 0,
    'stale 降级是普通发言语义：不得还原任务参数且应清除取证');
  assert.ok(gate.indexOf('thinkingOverride, contextOverride, modelOverride, accessOverride, loopLabel)') >= 0,
    '异步链路必须把还原后的 override 传入 buildStreamFlux');
  // 端点输出键与前端消费键同名字段契约：name/model/thinkingDepth/contextLength/accessMode/at
  assert.ok(controller.indexOf('out.put("model",') >= 0, 'loop-run 端点必须输出 model 键（与前端 info.model 对齐）');
});

test('字段契约：banner 模型栏读 loop-run 端点输出的 model 键', () => {
  // 2026-10-17 review 实锤缺陷：端点输出键是 model（loopRunEvidenceFromContext 与旧快照
  // 派生路径同键），banner 却读 info.modelName（早期任务定义注入链路的残留字段名）
  // → 模型栏恒显「默认模型」。本测试双向锁死字段名，防止任一侧再漂。
  const js = read(path.join(staticRoot, 'js', 'app-base.js'));
  assert.ok(js.indexOf('info.model ||') >= 0, 'banner 模型栏必须读 info.model（loop-run 端点输出键）');
  assert.ok(js.indexOf('info.modelName') < 0, 'modelName 是旧注入链路残留字段名，端点不返回该键');
  const controller = read(path.join(moduleRoot, 'src', 'main', 'java', 'com', 'gourdai', 'core', 'portal', 'web', 'WebController.java'));
  assert.ok(controller.indexOf('out.put("model",') >= 0, 'loop-run 端点必须输出 model 键');
});

test('app.css 含提示条样式（含完全访问高风险态）', () => {
  const css = read(path.join(staticRoot, 'css', 'app.css'));
  assert.ok(/\.loop-run-banner\s*\{/.test(css), '缺少 .loop-run-banner 样式');
  assert.ok(/\.loop-run-banner\s+\.loop-run-tag\.is-full/.test(css), '缺少完全访问高风险态样式');
});

test('12 个语言包：运行参数提示条 6 键齐全且非空', () => {
  const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'ja', 'ru', 'el', 'es', 'fr', 'pt', 'ro', 'vi'];
  const KEYS = ['run_banner_title', 'run_banner_desc', 'run_banner_default',
    'run_banner_model', 'run_banner_thinking', 'run_banner_context'];
  for (const lang of LOCALES) {
    const data = JSON.parse(read(path.join(staticRoot, 'locales', lang + '.json')));
    for (const key of KEYS) {
      const v = data.settings && data.settings.loop && data.settings.loop[key];
      assert.ok(typeof v === 'string' && v.trim().length > 0,
        `${lang}.json settings.loop.${key} 缺失或为空`);
    }
  }
});
