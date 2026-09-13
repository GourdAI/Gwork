const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

/**
 * 背景（CDP LayerTree 实测，勿凭感觉回退）：
 * 状态点闪动一旦用 opacity 关键帧，Chrome 会以 compositingReason=ActiveOpacityAnimation
 * 把每个 10x10 圆点提升为独立合成层；祖先 overflow:hidden + 外层滚动容器叠加后，
 * 滚动/拖动时该层与主层重绘不同步，圆点脱离 header「掉队」到卡片下方。
 * 实测：改前 4 个独立层（两张 agent 卡 + 思考块 + 工具卡），改后 0 个。
 */

// —— 提取 @keyframes 块体（花括号配平，避免被内部 { } 截断）——
function extractKeyframes(css, name) {
    const re = new RegExp('@keyframes\\s+' + name + '\\s*\\{');
    const m = re.exec(css);
    if (!m) return null;
    let i = m.index + m[0].length;
    const start = i;
    let depth = 1;
    while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
        i++;
    }
    return depth === 0 ? css.slice(start, i - 1) : null;
}

// —— 判定关键帧是否会触发合成层提升（合成器可加速属性）——
function promotesCompositingLayer(keyframeBody) {
    const stripped = String(keyframeBody).replace(/\/\*[\s\S]*?\*\//g, '');
    return /(^|[;{\s])(opacity|transform|rotate|scale|translate|filter|backdrop-filter)\s*:/.test(stripped);
}

// —— 提取单条规则体 —— 
function ruleBody(css, selector) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = css.match(new RegExp('^[ \\t]*' + esc + '\\s*\\{([^}]*)\\}', 'm'));
    return m ? m[1] : null;
}

const hasPaintContainment = (body) => /(^|[;{\s])contain\s*:\s*[^;]*\bpaint\b/.test(String(body));

test('状态点闪动不得使用 opacity/transform 关键帧（否则重现合成层残影）', () => {
    const css = readStatic('css', 'app.css');
    const body = extractKeyframes(css, 'status-dot-blink');
    assert.ok(body, '@keyframes status-dot-blink 应存在');
    assert.equal(promotesCompositingLayer(body), false,
        'status-dot-blink 含合成器可加速属性，会让状态点被提升为独立合成层，滚动/拖动时产生位置残影');
    assert.match(body, /background-color\s*:/, '闪动应改用 background-color 插值（主线程绘制，不提升层）');
});

test('负样本对照：旧版 opacity 关键帧必须被检测判定为不合格', () => {
    // 若此用例通过而上一用例恒真，说明检测形同虚设 —— 用真实的「修复前」写法反向验证
    const legacy = ' 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } ';
    assert.equal(promotesCompositingLayer(legacy), true, '检测函数必须能识别出 opacity 关键帧');
    assert.equal(promotesCompositingLayer(' 0% { transform: scale(1); } '), true, '检测函数必须能识别出 transform 关键帧');
    // 且当前写法与旧写法必须真的不同
    const current = extractKeyframes(readStatic('css', 'app.css'), 'status-dot-blink');
    assert.notEqual(promotesCompositingLayer(current), promotesCompositingLayer(legacy));
});

test('闪动暗态取主题变量而非硬编码，避免明暗主题串色', () => {
    const css = readStatic('css', 'app.css');
    const body = extractKeyframes(css, 'status-dot-blink');
    assert.match(body, /var\(--color-success\b/, '常亮态应取 --color-success');
    assert.match(body, /var\(--color-success-dim\b/, '暗态应取 --color-success-dim');

    // 每个定义了 --color-success 的主题作用域，都必须同步定义 --color-success-dim
    const theme = readStatic('css', 'theme.css');
    const successCount = (theme.match(/--color-success\s*:/g) || []).length;
    const dimCount = (theme.match(/--color-success-dim\s*:/g) || []).length;
    assert.ok(successCount >= 3, '主题文件应至少覆盖 light / dark / prefers-color-scheme 三个作用域');
    assert.equal(dimCount, successCount,
        `每个定义 --color-success 的主题都必须定义 --color-success-dim（当前 ${successCount} vs ${dimCount}）`);
});

test('状态点所在 header 启用 paint containment，抵抗分层残影', () => {
    const css = readStatic('css', 'app.css');
    for (const sel of ['.tool-card-header', '.agent-card-header', '.thinking-block-header']) {
        const body = ruleBody(css, sel);
        assert.ok(body, `${sel} 规则应存在`);
        assert.equal(hasPaintContainment(body), true, `${sel} 应声明 contain: paint`);
    }
});

test('负样本对照：缺少 contain 的规则必须被检测判定为不合格', () => {
    assert.equal(hasPaintContainment('display: flex; overflow: hidden;'), false);
    assert.equal(hasPaintContainment('contain: layout;'), false, 'layout containment 不等于 paint containment');
    assert.equal(hasPaintContainment('contain: paint;'), true);
    assert.equal(hasPaintContainment('contain: layout paint;'), true);
});

test('闪动态状态点不得带 box-shadow，否则 background-color 与 opacity 不再视觉等价', () => {
    // opacity 会连同发光一起淡化，background-color 不会；三处 loading 态必须无 box-shadow
    const css = readStatic('css', 'app.css');
    const loadingRules = [
        '.tool-status-icon.loading',
        '.agent-status-icon.loading',
        '.thinking-block.streaming .thinking-status-dot'
    ];
    for (const sel of loadingRules) {
        const body = ruleBody(css, sel);
        assert.ok(body, `${sel} 规则应存在`);
        assert.match(body, /status-dot-blink/, `${sel} 应复用统一闪动动画`);
        const shadow = body.match(/box-shadow\s*:\s*([^;]+)/);
        if (shadow) {
            assert.match(shadow[1].trim(), /^none$/,
                `${sel} 闪动态若带 box-shadow，改用 background-color 后发光不再随闪动淡化，视觉将与原实现不一致`);
        }
    }
});
