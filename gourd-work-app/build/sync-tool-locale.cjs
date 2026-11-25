/* 一次性同步脚本：把 PC 权威 locale 的工具展示键移植到移动端 12 语言包。
 * 键名保持 chat.tool_* / chat.batch_* 等扁平点号（移动端 i18n 全扁平）。
 * 同时修订移动端既有键文案（批准/已思考/智能体等对齐 PC）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const pcDir = path.resolve(__dirname, '../../gourd-work/desktop/ui/locales');
const appDir = path.resolve(__dirname, '../locale');
const map = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', en: 'en', de: 'de', ja: 'ja', ru: 'ru', el: 'el', es: 'es', fr: 'fr', pt: 'pt', ro: 'ro', vi: 'vi' };

/* 从 PC 移植的键（chat.* 下）：工具名全表 + 批次/思考/授权/智能体文案 */
const PORT = [
  'tool_read', 'tool_write', 'tool_edit', 'tool_grep', 'tool_glob', 'tool_ls',
  'tool_bash', 'tool_bash_output', 'tool_skill', 'tool_todo', 'tool_code',
  'tool_codesearch', 'tool_websearch', 'tool_webfetch', 'tool_task', 'tool_multitask',
  'tool_generate', 'tool_mcp', 'tool_openapi', 'tool_lsp', 'tool_memory', 'tool_recall',
  'tool_ask_user', 'tool_config', 'tool_clock', 'tool_plan', 'tool_plan_progress', 'tool_plan_revise',
  'action_bash_done', 'action_thinking_done', 'batch_done_count', 'batch_thinking_count',
  'batch_running', 'batch_done', 'need_auth', 'rejected', 'agent_label', 'items'
];

/* 移动端既有键的文案修订（以 PC 为准）：值从 PC chat.* 取，取不到用 zh 手工表 */
const REVISE = {
  'chat.interact.approve': { pc: 'approve' },          // 同意 → 批准
  'chat.segment.thinking': { pc: null, zh: '思考中' },  // 思考 → 思考中（运行态）
};
/* 思考中运行态文案 PC 是 chat.action_thinking（「思考中」）；核对 PC 键 */
const THINKING_RUNNING_PC = 'thinking_in_progress';

const zhManual = {
  'chat.interact.approve': '批准',
  'chat.segment.thinking': '思考中'
};

let fail = 0;
for (const [appLang, pcLang] of Object.entries(map)) {
  const pcPack = JSON.parse(fs.readFileSync(path.join(pcDir, pcLang + '.json'), 'utf8'));
  const pcChat = pcPack.chat || {};
  const appPath = path.join(appDir, appLang + '.json');
  const appPack = JSON.parse(fs.readFileSync(appPath, 'utf8'));

  /* 1) 移植键：插在 chat.segment.thinking 之前，保持 chat.* 聚簇 */
  const entries = Object.entries(appPack);
  const out = {};
  let inserted = false;
  const portEntries = [];
  for (const k of PORT) {
    const v = pcChat[k];
    if (typeof v !== 'string' || v.length === 0) { console.log('WARN', pcLang, 'missing chat.' + k); fail++; continue; }
    portEntries.push(['chat.' + k, v]);
  }
  /* 思考运行态：PC action_thinking（若存在）否则 zh 手工「思考中」 */
  for (const [k, v] of entries) {
    if (k === 'chat.segment.thinking' && !inserted) {
      for (const [pk, pv] of portEntries) out[pk] = pv;
      inserted = true;
    }
    out[k] = v;
  }
  if (!inserted) for (const [pk, pv] of portEntries) out[pk] = pv;

  /* 2) 修订既有键 */
  out['chat.interact.approve'] = typeof pcChat.approve === 'string' ? pcChat.approve : (appLang.startsWith('zh') ? '批准' : out['chat.interact.approve']);
  const thinkRun = pcChat[THINKING_RUNNING_PC];
  if (typeof thinkRun === 'string' && thinkRun.length > 0) out['chat.segment.thinking'] = thinkRun;
  else if (appLang === 'zh-Hans') out['chat.segment.thinking'] = '思考中';
  else if (appLang === 'zh-Hant') out['chat.segment.thinking'] = '思考中';
  /* 子代理行标签：PC「智能体 {name}」分列形态（旧「子代理 · {name}」废弃） */
  const agentLabel = typeof pcChat.agent_label === 'string' ? pcChat.agent_label : '智能体';
  out['chat.segment.agent'] = agentLabel + ' {name}';
  out['chat.segment.agentFallback'] = agentLabel;

  /* 3) 新增键：已拒绝闭环 / 思考耗时后缀 / 智能体名分列 / 页脚时间 */
  const add = {};
  add['chat.interact.rejectedTool'] = (typeof pcChat.rejected === 'string' ? pcChat.rejected : '已拒绝：') + '{name}';
  add['chat.interact.needAuthTool'] = (typeof pcChat.need_auth === 'string' ? pcChat.need_auth : '需要授权：') + '{name}';
  add['chat.segment.thinkingDone'] = (typeof pcChat.action_thinking_done === 'string' ? pcChat.action_thinking_done : '已思考') + ' ({time})';
  add['chat.segment.agentName'] = (typeof pcChat.agent_label === 'string' ? pcChat.agent_label : '智能体') + ' {name}';
  /* 插在 chat.interact.resolved 之后 */
  const final = {};
  let added = false;
  for (const [k, v] of Object.entries(out)) {
    final[k] = v;
    if (k === 'chat.interact.resolved' && !added) { for (const [ak, av] of Object.entries(add)) final[ak] = av; added = true; }
  }
  if (!added) for (const [ak, av] of Object.entries(add)) final[ak] = av;

  fs.writeFileSync(appPath, JSON.stringify(final, null, '\t') + '\n', 'utf8');
  console.log('OK', appLang, 'keys', Object.keys(final).length);
}
process.exit(fail ? 1 : 0);