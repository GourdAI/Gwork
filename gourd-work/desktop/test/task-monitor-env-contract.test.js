/**
 * 任务监控「环境信息」区契约护栏 —— 2026-11 用户报障的两个真实缺陷防回归。
 *
 * 【缺陷①：有变更却一直显示「无变更」】后端 /web/chat/git/status 的
 * changed/staged/untracked 是【文件路径数组】（Java GitService.status 与 Rust
 * gitops::status 同口径），旧前端却做 `(status.changed || 0) + ...` 算术加法：
 * 数组相加得字符串拼接，`> 0` 恒 false → 永远渲染「无变更」。修复口径：统一走
 * bucketCount()（Array.isArray ? length : 0）。本护栏锁死「不得再对三个桶做裸加法」。
 *
 * 【缺陷②：「领先 -1 / 落后 -1」】-1 是后端「计数不可得」哨兵（Java
 * REV_COUNT_UNKNOWN / Rust 同值；Rust 的 porcelain 头部省略 [ahead N, behind M]
 * 尾缀时也回 -1），旧前端直接渲染哨兵。修复口径：双 -1 走 sync_unknown/synced
 * 分支，其余分支 Math.max(0, ...) 兜底。本护栏锁死「哨兵分支必须先于 ahead_behind
 * 渲染分支出现」。
 *
 * 【参照稿对齐】首行彩色 +/-（.tm-diff-add/.tm-diff-del）与「提交或推送」
 * （monitor.commit_or_push）是用户参照稿形态，双份前端镜像 + 12 语种文案必须齐备。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');

const JS_COPIES = [
    path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'js', 'app-task-monitor.js'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'js', 'app-task-monitor.js'),
];
const CSS_COPIES = [
    path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'css', 'task-monitor.css'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'css', 'task-monitor.css'),
];
const LOCALE_DIRS = [
    path.join(ROOT, 'gourd-work', 'desktop', 'ui', 'locales'),
    path.join(ROOT, 'gourdai-java', 'gourd-ai-agent', 'src', 'main', 'resources', 'static', 'locales'),
];
const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'el', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi'];

/** 剥离 JS 注释：缺陷①的旧写法会作为事故记录出现在注释里，不剥离会误报。 */
function stripJsComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' ');
}

for (const p of JS_COPIES) {
    test('环境区变更数不得对数组桶做裸加法: ' + path.basename(path.dirname(path.dirname(p))), () => {
        const src = stripJsComments(fs.readFileSync(p, 'utf8'));
        /* 断言按【语义】而非【字面变量名】：缺陷①的本质是「把数组桶当数字加」，
           不管它叫 status 还是 st（null 归一后的局部别名）。锁死变量名会让正常重构
           无故变红，也拦不住换个名字重犯。 */
        assert.ok(!/\(\s*[\w$]+\.changed\s*\|\|\s*0\s*\)/.test(src),
            '缺陷①回归：changed 桶被当作数字相加（后端返回的是数组）');
        assert.ok(!/\(\s*[\w$]+\.(staged|untracked)\s*\|\|\s*0\s*\)/.test(src),
            '缺陷①回归：staged/untracked 桶被当作数字相加');
        assert.ok(/bucketCount\(\s*[\w$]+\.changed\s*\)\s*\+\s*bucketCount\(\s*[\w$]+\.staged\s*\)\s*\+\s*bucketCount\(\s*[\w$]+\.untracked\s*\)/.test(src),
            '三个桶必须统一经 bucketCount() 取 length 求和');
    });

    test('-1 哨兵分支必须先于 ahead_behind 渲染: ' + path.basename(path.dirname(path.dirname(p))), () => {
        const src = stripJsComments(fs.readFileSync(p, 'utf8'));
        const sentinel = src.indexOf('rm.ahead === -1 && rm.behind === -1');
        const render = src.indexOf("t('monitor.ahead_behind'");
        assert.ok(sentinel > 0, '必须存在双 -1 哨兵治理分支');
        assert.ok(render > 0, '必须存在 ahead_behind 渲染分支');
        assert.ok(sentinel < render, '哨兵分支必须先于 ahead_behind 分支判定，否则 -1 会露给用户');
        assert.ok(/Math\.max\(0,\s*rm\.ahead/.test(src) && /Math\.max\(0,\s*rm\.behind/.test(src),
            '单侧哨兵必须有 Math.max(0, ...) 兜底');
    });

    test('参照稿文案键在渲染中被消费: ' + path.basename(path.dirname(path.dirname(p))), () => {
        const src = fs.readFileSync(p, 'utf8');
        assert.ok(src.includes("t('monitor.commit_or_push')"), '缺少「提交或推送」行动提示');
        assert.ok(src.includes("t('monitor.sync_unknown')"), '缺少「同步状态未知」降级文案');
        assert.ok(src.includes('tm-diff-add') && src.includes('tm-diff-del'), '缺少彩色 +/- 行级统计渲染');
    });
}

for (const p of CSS_COPIES) {
    test('彩色 +/- 样式齐备: ' + path.basename(path.dirname(path.dirname(p))), () => {
        const css = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const sel of ['.tm-diff-add', '.tm-diff-del']) {
            assert.ok(new RegExp(sel.replace('.', '\\.') + '\\s*\\{').test(css), '缺少 ' + sel + ' 规则');
        }
    });
}

for (const dir of LOCALE_DIRS) {
    for (const loc of LOCALES) {
        test('文案键齐备 ' + loc + ' (' + path.basename(path.dirname(path.dirname(dir))) + ')', () => {
            const j = JSON.parse(fs.readFileSync(path.join(dir, loc + '.json'), 'utf8'));
            const m = j.monitor || {};
            assert.ok(typeof m.commit_or_push === 'string' && m.commit_or_push.length > 0, loc + ' 缺 monitor.commit_or_push');
            assert.ok(typeof m.sync_unknown === 'string' && m.sync_unknown.length > 0, loc + ' 缺 monitor.sync_unknown');
        });
    }
}
