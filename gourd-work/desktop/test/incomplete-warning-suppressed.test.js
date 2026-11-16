/**
 * 回归钉：「变更汇总可能不完整」警示一律不上界面（2026-11 用户拍板）。
 *
 * 背景：用户明确要求该警示「就算展示不全，在页面上也不要展示」，两个渲染面已拆除——
 *   · app-file-changes.js 的警示条（.file-changes-warning + incompleteText()）；
 *   · app-task-monitor.js「本会话产出」区的警示行（incompleteOutputsRow()）。
 * 后端 possiblyIncomplete / incompleteReasons 仅作契约字段保留（监控/排障），前端不得再消费。
 *
 * 为什么钉在 desktop 侧：前端唯一源是 gourd-work/desktop/ui，Java static 为镜像
 * （见 batch-count-contract.test.js / task-monitor-env-render.test.js 的同款说明）。
 * Java 侧 file-changes-ui.test.js 已对 static 镜像钉了 doesNotMatch，但唯一源侧此前无锁，
 * 且 app-file-changes.js 缺姊妹文件那样的镜像字节锁——单侧改 desktop/ui 恢复警示不会红。
 * 本文件同时锁「两份字节一致」+「两份剥注释后都无警示代码/文案残留」，任一侧复活立即红。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..', '..', '..');
const desktop = path.resolve(__dirname, '..');                 // gourd-work/desktop
const DESKTOP_UI = path.join(desktop, 'ui');
const JAVA_STATIC = path.join(repo, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');

const rd = (abs) => fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '').split(/\r\n|\n/).join('\n');
/* 剥块注释与整行行注释：允许注释里解释「后端仍提供该字段」，但代码体不得读取/渲染。 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
const md5 = (abs) => crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex');
const pair = (rel) => [path.join(DESKTOP_UI, rel), path.join(JAVA_STATIC, rel)];

test('★ 两份 app-file-changes.js 镜像字节一致（单侧改动会被同步冲掉）', () => {
    const [d, j] = pair(path.join('js', 'app-file-changes.js'));
    for (const f of [d, j]) assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
    assert.equal(md5(d), md5(j), '两份 app-file-changes.js 必须逐字一致');
});

test('★ 两份 app-task-monitor.js 镜像字节一致', () => {
    const [d, j] = pair(path.join('js', 'app-task-monitor.js'));
    for (const f of [d, j]) assert.ok(fs.existsSync(f), '镜像缺失: ' + f);
    assert.equal(md5(d), md5(j), '两份 app-task-monitor.js 必须逐字一致');
});

test('★ 变更卡片面：两份 app-file-changes.js 剥注释后均无警示残留', () => {
    for (const f of pair(path.join('js', 'app-file-changes.js'))) {
        const code = stripComments(rd(f));
        const tag = path.basename(path.dirname(path.dirname(f))) + '/' + path.basename(f);
        assert.doesNotMatch(code, /incompleteText\s*\(/, `${tag}: incompleteText() 不得复活`);
        assert.doesNotMatch(code, /summary\.incompleteReasons/, `${tag}: 不得读取 incompleteReasons 渲染警示`);
        assert.doesNotMatch(code, /\.possiblyIncomplete\b/, `${tag}: 不得读取 possiblyIncomplete 渲染警示`);
        assert.doesNotMatch(code, /file-changes-warning/, `${tag}: 警示条样式类不得复活`);
    }
});

test('★ 任务监控面：两份 app-task-monitor.js 剥注释后均无警示行残留', () => {
    for (const f of pair(path.join('js', 'app-task-monitor.js'))) {
        const code = stripComments(rd(f));
        const tag = path.basename(path.dirname(path.dirname(f))) + '/' + path.basename(f);
        assert.doesNotMatch(code, /incompleteOutputsRow/, `${tag}: incompleteOutputsRow() 不得复活`);
        assert.doesNotMatch(code, /\.possiblyIncomplete\b/, `${tag}: 不得读取 possiblyIncomplete 渲染警示行`);
    }
});

test('★ 两份 app.css 均无 .file-changes-warning 规则', () => {
    for (const f of pair(path.join('css', 'app.css'))) {
        assert.doesNotMatch(rd(f), /\.file-changes-warning\b/,
            `${path.basename(path.dirname(path.dirname(f)))}/app.css: 警示样式规则不得复活`);
    }
});

test('★ 两份 locales ×12 语种 file_changes 块均无警示文案键', () => {
    const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'el', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi'];
    const BANNED = ['possibly_incomplete', 'possibly_incomplete_detail'];
    for (const loc of LOCALES) {
        for (const root of [DESKTOP_UI, JAVA_STATIC]) {
            const f = path.join(root, 'locales', loc + '.json');
            const block = (JSON.parse(rd(f)).file_changes) || {};
            for (const k of BANNED) {
                assert.ok(!(k in block),
                    `${path.basename(path.dirname(path.dirname(root)))}/${loc}.json: 警示文案键 ${k} 复活`);
            }
        }
    }
});
