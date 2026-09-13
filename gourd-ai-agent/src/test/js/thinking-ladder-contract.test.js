const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const javaRoot = path.resolve(__dirname, '../../main/java');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (...parts) => fs.readFileSync(path.join(javaRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const LOCALES = ['de', 'el', 'en', 'es', 'fr', 'ja', 'pt', 'ro', 'ru', 'vi', 'zh-CN', 'zh-TW'];

// ====================================================================
// 一、前端不得再持有档位表（改造前共 4 份真源靠注释约定同步）
// ====================================================================

test('聊天页已删除按接口类型硬编码的档位表', () => {
    const history = readStatic('js', 'app-history.js');
    assert.doesNotMatch(history, /buildThinkingProfiles/,
        'buildThinkingProfiles 是旧的 4 套档位表工厂，必须已删除');
    assert.doesNotMatch(history, /thinkingProfileKey/,
        'thinkingProfileKey 按 standard 分流，与「能力按模型而非按接口」相悖，必须已删除');
    assert.doesNotMatch(history, /THINKING_PROFILE_FALLBACK/);
});

test('聊天页改为消费后端下发的 thinkingLevels，并导出给其它页复用', () => {
    const history = readStatic('js', 'app-history.js');
    assert.match(history, /function thinkingLevelsOfModel\(/);
    assert.match(history, /function thinkingOptionsForModel\(/);
    assert.match(history, /window\.thinkingOptionsForModel = thinkingOptionsForModel;/);
    // 模型列表必须承接该字段，否则档位收缩无数据来源
    assert.match(history, /thinkingLevels:\s*\(Object\.prototype\.toString\.call\(list\[i\]\.thinkingLevels\)/);
});

test('自动化页不再自带档位数组，改调聊天页导出的唯一真源', () => {
    const auto = readStatic('js', 'app-automation.js');
    assert.doesNotMatch(auto, /buildThinkingProfiles|thinkingProfileKey/);
    assert.doesNotMatch(auto, /\[\s*'off'\s*,\s*'minimal'/,
        "旧兜底数组 ['off','minimal',...] 必须已删除");
    assert.match(auto, /window\.thinkingOptionsForModel\(modelName\)/);
});

test('三个页面都不再把 minimal 当可选档位（统一 5 档不含 minimal）', () => {
    for (const file of ['app-history.js', 'app-automation.js', 'app-settings-acp.js']) {
        const src = readStatic('js', file);
        assert.doesNotMatch(src, /value:\s*'minimal'/, `${file} 不应再渲染 minimal 档`);
        assert.doesNotMatch(src, /history\.thinking\.minimal\.label/, `${file} 不应再取 minimal 文案`);
    }
});

// ====================================================================
// 二、off → auto 改名彻底性：'off' 仅允许作为历史值出现在归一化函数里
// ====================================================================

test("档位值 'off' 只允许存在于历史值归一化逻辑中", () => {
    const checks = [
        ['app-history.js', /function normalizeThinkingCode\(/],
        ['app-automation.js', /function normThinking\(/],
        ['app-settings-acp.js', /function normalizeThinking\(/],
    ];
    for (const [file, normalizerRe] of checks) {
        const src = readStatic('js', file);
        assert.match(src, normalizerRe, `${file} 应有历史值归一化函数`);
        // 归一化函数内部必有 off → auto 的映射（可能写字面量，也可能用常量）
        assert.match(src, /d === 'off'\)\s*return\s*(THINKING_AUTO|'auto')/,
            `${file} 必须把历史值 off 归一为 auto`);
        // 除归一化与注释外，不得再有把 'off' 当档位值用的比较/赋值
        assert.doesNotMatch(src, /thinking\s*[=!]==?\s*'off'/, `${file} 不应再按 'off' 判定档位`);
        assert.doesNotMatch(src, /=\s*'off';/, `${file} 不应再把档位赋值为 'off'`);
    }
});

test('默认档位常量为 auto 且语义是「不注入参数」', () => {
    const history = readStatic('js', 'app-history.js');
    assert.match(history, /var THINKING_AUTO = 'auto';/);
    assert.match(history, /history\.thinking\.auto\.label/);
    assert.doesNotMatch(history, /history\.thinking\.off\.label/,
        'i18n 键已改名，仍引用 off 会显示 key 字面量');
});

// ====================================================================
// 三、S2 降级：空档位列表必须隐藏选择器
// ====================================================================

test('无可调档位时必须隐藏选择器，而不是渲染出无效档位', () => {
    const acp = readStatic('js', 'app-settings-acp.js');
    // 只剩「默认」一项说明该模型无可区分档位，此时不渲染整行
    assert.match(acp, /if \(opts\.length <= 1\) return '';/);
});

test('thinkingLevels 的 null 与 [] 语义必须分离（旧接口兜底 vs 明确不可调）', () => {
    for (const file of ['app-history.js', 'app-settings-acp.js']) {
        const src = readStatic('js', file);
        // 非数组一律归一为 null，交由调用方走兜底；不得把 null 折叠成空数组
        assert.match(src, /\?\s*[\w.\[\]]+\s*:\s*null/,
            `${file} 字段缺失应归一为 null 而非 []`);
        assert.match(src, /\[object Array\]/,
            `${file} 应显式校验 thinkingLevels 是否为数组`);
        assert.match(src, /levels\s*==\s*null/, `${file} 应区分 null 与空数组`);
    }
});

// ====================================================================
// 四、后端契约
// ====================================================================

const JAVA_WEB = ['com', 'gourdai', 'core', 'portal', 'web'];

test('后端已消灭 ANTHROPIC_USE_EFFORT 编译期常量（它使 Anthropic 必错一边）', () => {
    const src = readJava(...JAVA_WEB, 'ThinkingDepth.java');
    assert.doesNotMatch(src, /ANTHROPIC_USE_EFFORT/,
        '该常量对全体 Anthropic 模型一刀切，经典 Claude 与现代 Claude 必有一方 400');
    assert.doesNotMatch(src, /ANTHROPIC_BUDGETS/, '硬编码预算表应改为比例换算');
});

test('统一档位枚举恰为 AUTO + 5 档，不含 minimal、不含关闭思考档', () => {
    const src = readJava(...JAVA_WEB, 'thinking', 'ThinkingLevel.java');
    for (const code of ['AUTO', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']) {
        assert.match(src, new RegExp(`\\b${code}\\("`), `枚举应含 ${code}`);
    }
    assert.doesNotMatch(src, /\bMINIMAL\("/, 'minimal 原厂支持率仅 14.7%，不作为统一档位');
    assert.doesNotMatch(src, /\bNONE\("/, '本系统不提供关闭思考能力');
    assert.match(src, /m\.put\("off", AUTO\)/, '历史落盘值 off 必须静默迁移为 AUTO');
    assert.match(src, /m\.put\("minimal", LOW\)/, '历史落盘值 minimal 必须静默迁移为 LOW');
});

test('原生 none 必须被排除出就近映射，否则选低档会意外关闭思考', () => {
    const src = readJava(...JAVA_WEB, 'thinking', 'ReasoningCapability.java');
    assert.match(src, /EFFORT_RANK/);
    assert.doesNotMatch(src, /m\.put\("none",/,
        'none 表示关闭思考，不得参与档位映射');
});

test('两个模型列表端点都必须下发 thinkingLevels（否则前端无法收缩档位）', () => {
    const chat = readJava(...JAVA_WEB, 'WebController.java');
    assert.match(chat, /item\.put\("thinkingLevels", ThinkingDepth\.selectableCodes\(/);
    const settings = readJava(...JAVA_WEB, 'WebSettingsController.java');
    assert.match(settings, /item\.put\("thinkingLevels", ThinkingDepth\.selectableCodes\(/,
        'ACP 设置页的数据源同样需要该字段');
});

test('模型能力覆写字段已通电（改造前 ModelDo.capabilities 无 getter/setter）', () => {
    const src = readJava('com', 'gourdai', 'core', 'config', 'entity', 'ModelDo.java');
    assert.match(src, /public Map<String, Object> getCapabilities\(\)/);
    assert.match(src, /public void setCapabilities\(Map<String, Object> capabilities\)/);
});

// ====================================================================
// 五、i18n 12 语种一致性
// ====================================================================

test('12 语种均已把 thinking.off 改名为 thinking.auto，且文案未丢失', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        const json = JSON.parse(raw);
        const thinking = json.history && json.history.thinking;
        assert.ok(thinking, `${lang}: history.thinking 段应存在`);
        assert.ok(thinking.auto, `${lang}: 应有 auto 档位文案`);
        assert.equal(thinking.off, undefined, `${lang}: off 键应已改名`);
        assert.ok(thinking.auto.label && thinking.auto.label.length > 0,
            `${lang}: auto.label 不应为空`);
        // 5 档文案必须齐备，否则下拉会显示 key 字面量
        for (const code of ['low', 'medium', 'high', 'xhigh', 'max']) {
            assert.ok(thinking[code] && thinking[code].label,
                `${lang}: 缺少 ${code} 档文案`);
        }
    }
});

test('提示文案不得再提及已不存在的 off 档位', () => {
    const en = JSON.parse(readStatic('locales', 'en.json'));
    const hint = en.settings.acp.thinking_hint;
    assert.ok(hint, 'thinking_hint 应存在');
    assert.doesNotMatch(hint, /\boff\b/i,
        'UI 上已无 off 选项，文案仍这么写会让用户找不到对应项');
});
