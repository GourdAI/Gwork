/**
 * 契约测试：技能清单预算设置项的前端接线。
 *
 * 背景（2026-10-27）：技能清单每轮都被拼进系统提示词，而 description 是市场安装的
 * 第三方内容。修复前既无单条上限也无总量上限（实测一条 10000 字描述让单轮提示词
 * 多出 10255 字符）。后端已加两道闸门并暴露为设置项，本测试锁定前端接线：
 *
 *  - HTML 两个输入框存在、min/max 与后端归一化区间一致、i18n 键齐全
 *  - JS 三处接线：collect（越界传 null 而非前端钳制）/ load（回显）/ 防抖监听
 *  - 12 份语言包都有 6 个键（缺键会让设置页显示原始 key）
 *  - **两份 UI 副本都接了线**：Java 内核读 static/，Rust 桌面壳读 desktop/ui/。
 *    只改一份会让另一个内核的设置页有输入框但不生效（或反之）。
 *
 * 断言刻意针对「赋值语句/行为本身」而不是「某个词出现过」：后者在注释里也能命中，
 * 把实现删掉测试仍全绿（这个坑踩过）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── 路径算术自证 ────────────────────────────────────────────────────────────
// __dirname = <repo>/gourdai-java/gourd-ai-agent/src/test/js
//
// 刻意不写死「向上 N 级」也不写死仓库名：本仓库经历过模块迁移（gourd-ai-agent 从
// 仓库根移入 gourdai-java/），写死层数的测试在迁移后就会静默指向错误目录。历史上
// 把镜像根算错一级、再配「不存在就 continue」，结果是从未真正比对过任何文件、
// 永远静默通过。这里改为向上探测「同时含 gourdai-java 与 gourd-work 的那一级」，
// 找不到就直接抛错而不是静默跳过。
function findRepoRoot(from) {
    let dir = from;
    for (let i = 0; i < 8; i++) {
        if (fs.existsSync(path.join(dir, 'gourdai-java')) && fs.existsSync(path.join(dir, 'gourd-work'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`无法从 ${from} 向上定位仓库根（需同时含 gourdai-java 与 gourd-work）`);
}

const REPO_ROOT = findRepoRoot(__dirname);
const STATIC_ROOT = path.join(REPO_ROOT, 'gourdai-java/gourd-ai-agent/src/main/resources/static');
const DESKTOP_UI_ROOT = path.join(REPO_ROOT, 'gourd-work/desktop/ui');

test('路径算术自证：两份 UI 根都真实存在且各自含 settings.html', () => {
    for (const root of [STATIC_ROOT, DESKTOP_UI_ROOT]) {
        assert.ok(fs.existsSync(root), `UI 根不存在: ${root}`);
        assert.ok(fs.existsSync(path.join(root, 'settings.html')), `缺 settings.html: ${root}`);
        assert.ok(fs.existsSync(path.join(root, 'js/app-settings-general.js')), `缺 app-settings-general.js: ${root}`);
        assert.ok(fs.existsSync(path.join(root, 'locales/zh-CN.json')), `缺 locales: ${root}`);
    }
    // 两份必须是不同目录，否则「两份都接线」的断言毫无意义
    assert.notEqual(STATIC_ROOT, DESKTOP_UI_ROOT);
    // static 必须在 gourdai-java 下、desktop/ui 必须在 gourd-work 下：
    // 若两者算到同一侧，说明探测逻辑退化成了「找到第一个就算」
    assert.ok(STATIC_ROOT.includes('gourdai-java'), `static 根不在 Java 模块下: ${STATIC_ROOT}`);
    assert.ok(DESKTOP_UI_ROOT.includes('gourd-work'), `desktop 根不在 Rust 模块下: ${DESKTOP_UI_ROOT}`);
});

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const I18N_KEYS = ['title', 'budget_fraction', 'budget_fraction_placeholder',
    'max_desc_chars', 'max_desc_chars_placeholder', 'hint'];

function read(root, ...segs) {
    return fs.readFileSync(path.join(root, ...segs), 'utf8').replace(/^\uFEFF/, '');
}

/** 去掉 JS 注释，避免「注释里出现过该词」造成假通过。 */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\/[^'"\n]*$/gm, '');
}

// ====================================================================
// HTML：两个输入框
// ====================================================================

for (const [label, root] of [['static', STATIC_ROOT], ['desktop/ui', DESKTOP_UI_ROOT]]) {
    test(`[${label}] settings.html 有两个预算输入框，min/max 与后端归一化区间一致`, () => {
        const html = read(root, 'settings.html');

        // min/max 必须与后端 SkillListingPolicy 的合法区间逐字一致：
        // 前端写 1~10 而后端接受 1~10 才不会出现「页面能填但后端回落默认值」
        assert.match(html, /id="generalSkillListingBudgetFraction"/, '缺预算百分比输入框');
        assert.match(html, /min="1"\s+max="10"[^>]*id="generalSkillListingBudgetFraction"/,
            '预算百分比的 min/max 与后端 normalizeFraction 区间(1~10)不一致');

        assert.match(html, /id="generalSkillListingMaxDescChars"/, '缺单条上限输入框');
        assert.match(html, /min="16"\s+max="8192"[^>]*id="generalSkillListingMaxDescChars"/,
            '单条上限的 min/max 与后端 normalizeMaxDescChars 区间(16~8192)不一致');

        // type=number：否则用户能填非数字，parseNumStr 返回 null 被当成「不修改」
        const block = html.slice(html.indexOf('技能清单预算') >= 0
            ? html.indexOf('settings.general.skills.title')
            : html.indexOf('settings.general.skills.title'));
        assert.ok(block.length > 0, '找不到技能清单预算卡片');
        assert.match(block.slice(0, 2000), /type="number"[^>]*id="generalSkillListingBudgetFraction"/);
        assert.match(block.slice(0, 2000), /type="number"[^>]*id="generalSkillListingMaxDescChars"/);
    });

    test(`[${label}] settings.html 的 i18n 键齐全（label + placeholder + 卡片标题 + 说明）`, () => {
        const html = read(root, 'settings.html');
        for (const k of ['settings.general.skills.title', 'settings.general.skills.budget_fraction',
            'settings.general.skills.budget_fraction_placeholder', 'settings.general.skills.max_desc_chars',
            'settings.general.skills.max_desc_chars_placeholder', 'settings.general.skills.hint']) {
            assert.ok(html.includes(`data-i18n${k.endsWith('placeholder') ? '-placeholder' : ''}="${k}"`),
                `缺 i18n 绑定: ${k}`);
        }
    });
}

// ====================================================================
// JS：三处接线
// ====================================================================

for (const [label, root] of [['static', STATIC_ROOT], ['desktop/ui', DESKTOP_UI_ROOT]]) {
    test(`[${label}] collectFormPayload 提交两个字段，且越界传 null（不在前端钳制）`, () => {
        const js = codeOnly(read(root, 'js', 'app-settings-general.js'));
        const fn = js.slice(js.indexOf('function collectFormPayload'));
        const body = fn.slice(0, fn.indexOf('\n    }'));

        assert.match(body, /skillListingBudgetFraction:/, '未提交 skillListingBudgetFraction');
        assert.match(body, /skillListingMaxDescChars:/, '未提交 skillListingMaxDescChars');

        // 必须读对应输入框，否则提交的是 undefined
        assert.match(body, /\$\('#generalSkillListingBudgetFraction'\)\.val\(\)/);
        assert.match(body, /\$\('#generalSkillListingMaxDescChars'\)\.val\(\)/);

        // 越界 → null（= 不修改，让后端回落默认值）。
        // 若改成前端钳制，会出现「页面显示的值」与「实际生效的值」不一致。
        assert.match(body, /v >= 1 && v <= 10\) \? v : null/, '预算百分比未按 1~10 过滤后传 null');
        assert.match(body, /v >= 16 && v <= 8192\) \? v : null/, '单条上限未按 16~8192 过滤后传 null');
        assert.doesNotMatch(body, /Math\.min\(10|Math\.max\(1,/, '不应在前端钳制（后端是单一真源）');
    });

    test(`[${label}] loadGeneralSettings 回显两个字段`, () => {
        const js = codeOnly(read(root, 'js', 'app-settings-general.js'));
        const fn = js.slice(js.indexOf('function loadGeneralSettings'));
        const body = fn.slice(0, fn.indexOf('window._settingsGeneral') > 0
            ? fn.indexOf('window._settingsGeneral') : fn.length);

        // 断言赋值语句本身，而不是「字段名出现过」
        assert.match(body, /\$\('#generalSkillListingBudgetFraction'\)\.val\(d\.skillListingBudgetFraction/,
            '未回显预算百分比');
        assert.match(body, /\$\('#generalSkillListingMaxDescChars'\)\.val\(d\.skillListingMaxDescChars/,
            '未回显单条上限');
        // null 安全：后端未返回时填空串而不是 "null"
        assert.match(body, /d\.skillListingBudgetFraction != null \? d\.skillListingBudgetFraction : ''/);
        assert.match(body, /d\.skillListingMaxDescChars != null \? d\.skillListingMaxDescChars : ''/);
    });

    test(`[${label}] 两个输入框都挂在防抖保存监听上（否则改了不保存）`, () => {
        const js = codeOnly(read(root, 'js', 'app-settings-general.js'));
        // 找到 input 事件委托那一行的选择器串
        const m = js.match(/\$\(document\)\.on\('input',\s*'([^']+)'/);
        assert.ok(m, '找不到 input 事件委托');
        const selector = m[1];
        assert.ok(selector.includes('#generalSkillListingBudgetFraction'),
            `预算百分比未挂防抖监听: ${selector}`);
        assert.ok(selector.includes('#generalSkillListingMaxDescChars'),
            `单条上限未挂防抖监听: ${selector}`);
        // 既有的几个不能被我挤掉
        for (const id of ['#generalHistoryWindowSize', '#generalCompressionRatio', '#generalApiRetries']) {
            assert.ok(selector.includes(id), `既有监听被破坏，缺 ${id}`);
        }
    });
}

// ====================================================================
// 语言包：12 份 × 6 键
// ====================================================================

for (const [label, root] of [['static', STATIC_ROOT], ['desktop/ui', DESKTOP_UI_ROOT]]) {
    test(`[${label}] 12 份语言包都有 settings.general.skills 的 6 个键`, () => {
        for (const loc of LOCALES) {
            const file = path.join(root, 'locales', loc + '.json');
            assert.ok(fs.existsSync(file), `缺语言包: ${loc}`);
            const parsed = JSON.parse(read(root, 'locales', loc + '.json'));
            const s = parsed.settings && parsed.settings.general && parsed.settings.general.skills;
            assert.ok(s, `${loc}: 缺 settings.general.skills 段`);
            for (const k of I18N_KEYS) {
                assert.ok(s[k] && String(s[k]).trim() !== '', `${loc}: skills.${k} 缺失或为空`);
            }
        }
    });

    test(`[${label}] 语言包叶子键数一致（缺键会让设置页显示原始 key）`, () => {
        const counts = {};
        for (const loc of LOCALES) {
            const parsed = JSON.parse(read(root, 'locales', loc + '.json'));
            const leaves = [];
            (function walk(o, p) {
                for (const [k, v] of Object.entries(o)) {
                    const key = p ? p + '.' + k : k;
                    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
                    else leaves.push(key);
                }
            })(parsed, '');
            counts[loc] = leaves.length;
        }
        const uniq = [...new Set(Object.values(counts))];
        assert.equal(uniq.length, 1, `叶子键数不一致: ${JSON.stringify(counts)}`);
    });

    test(`[${label}] 既有的 settings.skills（技能管理页文案）未被新段破坏`, () => {
        // settings.general.skills 与 settings.skills 是不同路径，但名字相近，
        // 插入时若定位错层级会覆盖掉技能管理页的全部文案。
        for (const loc of ['zh-CN', 'en']) {
            const parsed = JSON.parse(read(root, 'locales', loc + '.json'));
            assert.ok(parsed.settings.skills && parsed.settings.skills.title,
                `${loc}: settings.skills 被破坏`);
            assert.ok(parsed.settings.general.skills.title !== parsed.settings.skills.title,
                `${loc}: 两段标题相同，疑似插错层级`);
        }
    });
}

// ====================================================================
// 两份 UI 的接线必须同源（防止只改一份）
// ====================================================================

test('两份 UI 的预算接线逐字一致（只改一份会让另一个内核的设置页失效）', () => {
    // 只比对本主题相关的片段：两份 UI 存在其它并行分歧（desktop/ui 已移除 LSP 等），
    // 整体比对会因无关差异而失败，掩盖真正要守的契约。
    function extractJs(root) {
        const js = codeOnly(read(root, 'js', 'app-settings-general.js'));
        const pick = (re) => {
            const m = js.match(re);
            assert.ok(m, `未匹配到 ${re} in ${root}`);
            return m[0];
        };
        return [
            pick(/skillListingBudgetFraction:[\s\S]{0,220}?\}\)\(\),/),
            pick(/skillListingMaxDescChars:[\s\S]{0,220}?\}\)\(\),/),
            pick(/\$\('#generalSkillListingBudgetFraction'\)\.val\([^;]+;/),
            pick(/\$\('#generalSkillListingMaxDescChars'\)\.val\([^;]+;/),
        ].join('\n---\n');
    }

    assert.equal(extractJs(STATIC_ROOT), extractJs(DESKTOP_UI_ROOT),
        '两份 UI 的 JS 接线不一致');

    function extractHtml(root) {
        const html = read(root, 'settings.html');
        const start = html.indexOf('settings.general.skills.title');
        assert.ok(start > 0, `未找到技能清单预算卡片: ${root}`);
        // 取卡片标题到说明结尾这一段
        const end = html.indexOf('settings.general.skills.hint', start);
        assert.ok(end > start, `卡片不完整: ${root}`);
        return html.slice(start, html.indexOf('</div>', end + 200));
    }

    assert.equal(
        extractHtml(STATIC_ROOT).replace(/\s+/g, ' '),
        extractHtml(DESKTOP_UI_ROOT).replace(/\s+/g, ' '),
        '两份 UI 的 HTML 卡片不一致'
    );

    // 语言包：6 个键的译文必须逐字相同（同一产品的两份副本不该有两种译法）
    for (const loc of LOCALES) {
        const a = JSON.parse(read(STATIC_ROOT, 'locales', loc + '.json')).settings.general.skills;
        const b = JSON.parse(read(DESKTOP_UI_ROOT, 'locales', loc + '.json')).settings.general.skills;
        assert.deepEqual(a, b, `${loc}: 两份 UI 的技能预算译文不一致`);
    }
});
