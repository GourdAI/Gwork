/**
 * 契约测试：助手身份头（头像 + 名称，默认 GWork、设置可改）。
 *
 * 静态接线守护（与 turn-compact.test.js 的接线守护同口径）：身份头是纯展示增强，
 * 真跑浏览器由 e2e 覆盖；这里钉住「五段链路每一环都在位」，任何一环被删/改名即红：
 *   1) 骨架：ensureAssistantBubble 的 row.innerHTML 以身份头开头；
 *   2) 刷新：refreshAssistantIdentity 定义并挂 window（设置页跨模块调用）；
 *   3) 设置页：输入框 + collect 回传 + load 回显 + 保存成功后刷身份头；
 *   4) 内核：GeneralSettings 字段 / GET echo / save body / persist patch 四处 assistantName；
 *   5) 文案：12 份语言包 identity 四键 + 折叠状态词三键齐全；CSS 有 .msg-head 规则。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, '..', 'ui');
const read = (p) => fs.readFileSync(p, 'utf8');
const msg = read(path.join(UI, 'js', 'app-message.js'));
const setg = read(path.join(UI, 'js', 'app-settings-general.js'));
const seth = read(path.join(UI, 'settings.html'));
const css = read(path.join(UI, 'css', 'app.css'));
const coreCfg = read(path.join(__dirname, '..', '..', 'core', 'src', 'config', 'mod.rs'));
const coreSrv = read(path.join(__dirname, '..', '..', 'core', 'src', 'server', 'mod.rs'));

test('骨架：assistant 行 innerHTML 以身份头开头（showHead=false 时省略），用户行不受影响', () => {
    assert.match(msg, /row\.innerHTML = \(showHead \? assistantIdentityHeaderHtml\(\) : ''\)/,
        '身份头是 assistant 行骨架的第一个节点，同 run 续段省略');
    assert.match(msg, /function assistantIdentityHeaderHtml\(\)/);
    assert.match(msg, /ASSISTANT_NAME_DEFAULT = 'GWork'/, '默认名称 GWork');
    assert.match(msg, /img\/logo\.svg/, '头像复用品牌 logo');
    // 名称是用户输入：进 innerHTML 前必须转义
    assert.match(msg, /assistantIdentityHeaderHtml[\s\S]{0,600}escapeHtml/, '名称必须转义后入 HTML');
});

test('同轮续段省略身份头：插话/问答/审批后不重复 GWork 头（2026-11 报障）', () => {
    // 判定函数在位：以「最近一条真实用户消息行」为轮界（插话行 steer-note 不算打断）
    assert.match(msg, /function assistantRowShouldShowHead\(sess\)/);
    assert.match(msg, /steer-note.*插话行不算打断|插话行不算打断/,
        '注释必须写明插话行不构成轮界');
    assert.match(msg, /r\.classList\.contains\('user'\) && !r\.classList\.contains\('steer-note'\)/,
        '用户行判定必须排除 steer-note 插话行');
    // 【code review 回归钉 2026-11】恢复段带全新 runId：按 runId 查旧行会失效，
    // 判定必须以用户行为轮界（帧日志 work-mw4m8qep 实证：挂起 run-18ba47b8 → 恢复 run-fd81760b）
    assert.ok(!/querySelector\('\.msg-row\.assistant\[data-run-id=/.test(msg),
        '不得按 runId 查旧行——ask/HITL 恢复段是新 runId，查不到会漏省头');
    // 无用户行（会话首条）/ 查询异常必须回退 true（宁可多显示，不可丢头）
    assert.match(msg, /if \(lastUser < 0\) return true;/);
    assert.match(msg, /if \(!root \|\| !root\.querySelector\) return true;/);
    assert.match(msg, /catch \(e\) \{ return true; \}/);
    // 接线：省头时挂 no-identity-head
    assert.match(msg, /if \(!showHead\) row\.classList\.add\('no-identity-head'\)/);
    // CSS：无头行补上缘间距（顶替 msg-head 的 6px 下缘）
    assert.match(css, /\.msg-row\.assistant\.no-identity-head \.msg-bubble \{ padding-top: 6px; \}/);
});

test('刷新：refreshAssistantIdentity 挂 window 且只改文本不重建行', () => {
    assert.match(msg, /function refreshAssistantIdentity\(name\)/);
    assert.match(msg, /window\.refreshAssistantIdentity = refreshAssistantIdentity/);
    assert.match(msg, /refreshAssistantIdentity[\s\S]{0,400}textContent = shown/, '只改文本节点');
    assert.ok(!/refreshAssistantIdentity[\s\S]{0,400}innerHTML =/.test(msg), '不得整行重建（会丢流式/折叠态）');
});

test('设置页：输入框、collect、load、保存后刷新四段接线', () => {
    assert.match(seth, /id="generalAssistantName"/);
    assert.match(seth, /data-i18n="settings\.general\.identity\.title"/);
    assert.match(setg, /assistantName: \(function \(\)/, 'collect 必须回传名称');
    assert.match(setg, /\$\('#generalAssistantName'\)\.val\(d\.assistantName/, 'load 必须回显');
    assert.match(setg, /refreshAssistantIdentity\(bodyObj\.assistantName\)/, '保存成功后刷聊天页');
    assert.match(setg, /#generalAssistantName', function \(\)/, '输入防抖保存');
});

test('内核：字段/GET/save/patch 四处 assistantName 齐全', () => {
    assert.match(coreCfg, /rename = "assistantName"/, 'GeneralSettings 字段');
    const gets = coreSrv.match(/"assistantName"/g) || [];
    assert.ok(gets.length >= 3, 'GET echo + save body + persist patch 至少三处，实际 ' + gets.length);
    assert.match(coreSrv, /double_option"\)\][\r\n]+\s*assistant_name/, '清空语义走 double_option');
});

test('文案：12 份语言包 identity 四键 + 状态词三键 + 单数键四键齐全，无死键', () => {
    const dir = path.join(UI, 'locales');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 12, '语言包份数');
    for (const f of files) {
        const j = JSON.parse(read(path.join(dir, f)));
        const idn = j.settings && j.settings.general && j.settings.general.identity;
        assert.ok(idn, f + ' 缺 settings.general.identity');
        for (const k of ['title', 'assistant_name', 'assistant_name_placeholder', 'hint']) {
            assert.ok(typeof idn[k] === 'string' && idn[k].trim(), f + ' 缺 identity.' + k);
        }
        for (const k of ['turn_done', 'turn_stopped', 'turn_suspended']) {
            assert.ok(typeof j.chat[k] === 'string' && j.chat[k].trim(), f + ' 缺 chat.' + k);
        }
        // n=1 单数形态（英语 "1 tool call"）：summaryText 的 countPart 依赖，12 包齐备
        for (const k of ['turn_tools_one', 'turn_thinking_one', 'turn_agents_one', 'turn_process_texts_one']) {
            assert.ok(typeof j.chat[k] === 'string' && j.chat[k].trim(), f + ' 缺 chat.' + k);
        }
        // 死键防回归：turn_thought_only 无任何消费方（2026-11 自审清除）
        assert.equal(j.chat.turn_thought_only, undefined, f + ' 不得残留死键 chat.turn_thought_only');
    }
});

test('启动同步：后端就绪后拉一次名称写缓存（跨端改名首启可见）', () => {
    // 缓存唯一读取源是 localStorage；若启动期不同步服务端值，在 web 模式/另一台机器
    // 改过名称的用户，本端首启永远显示默认 GWork（直到手动进设置页保存一次）。
    assert.match(msg, /function syncAssistantNameFromServer\(\)/, '必须有启动同步函数');
    assert.match(msg, /syncAssistantNameFromServer\(\);/, '模块加载即注册（经 __whenBackendReady 门闸）');
    assert.match(msg, /syncAssistantNameFromServer[\s\S]{0,500}\$\.get\('\/web\/settings\/general'/, '同步必须拉设置接口');
    assert.match(msg, /syncAssistantNameFromServer[\s\S]{0,700}localStorage\.setItem\(ASSISTANT_NAME_KEY/, '拉到值必须写缓存');
    assert.match(msg, /syncAssistantNameFromServer[\s\S]{0,700}localStorage\.removeItem\(ASSISTANT_NAME_KEY/, '服务端清空必须删缓存（回落默认）');
    // 注释不得再声称不存在的机制（2026-11 自审：旧注释描述了未实现的 dispatch 事件）
    assert.ok(!/gwork:assistantNameChanged/.test(msg), '不得残留未实现事件的注释/代码');
});

test('CSS：.msg-head 三规则在位且暗色头像反色', () => {
    assert.match(css, /\.msg-head \{ display: flex/);
    assert.match(css, /\.msg-head-avatar \{/);
    assert.match(css, /\.msg-head-name \{/);
    assert.match(css, /\[data-theme="dark"\] \.msg-head-avatar \{ filter: invert\(1\)/);
});
