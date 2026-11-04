/**
 * 契约测试：Markdown 裸链接自动识别的中文边界（修复「链接吞掉后文」）。
 *
 * 背景：marked 的 GFM autolink 以「非空白」界定 URL 结尾，汉字与全角标点都不是空白，
 * 因此「设计稿在这，https://lanhuapp.com/...，去实现官网改版」会把 URL 之后的整段中文
 * 一起识别为链接（并被 encodeURI 编进 href），表现为链接无限长、正文全部变蓝、点击跳错地址。
 *
 * 覆盖：
 * - app-ui.js：存在 gourdAutolink 内联扩展（ASCII 字符集 + 句读/引号/未闭合括号裁剪），
 *   且注册在 marked.setOptions 之后、renderMd 之前（保证所有渲染路径共用同一 marked 实例）
 * - 真实 marked 端到端：中文正文不再被吞、URL 参数完整、以及 8 类形态回归
 *   （全角逗号/句号边界、括号配平、www. 前缀、markdown 链接、行内代码、
 *    尖括号 autolink、邮箱、一行多链接）
 * - trimAutoLink 纯函数行为（可脱离 marked 单独断言）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const appUi = readStatic('js', 'app-ui.js');

function sliceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `未找到起始标记: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `未找到结束标记: ${endMarker}`);
    return source.slice(start, end);
}

/** 取出扩展核心（不含 marked.use 注册行），在沙箱中实例化真实函数。 */
function loadAutolinkCore() {
    const core = sliceBetween(appUi, '/*AUTOLINK-CORE-START*/', '/*AUTOLINK-CORE-END*/');
    return new Function(core + '\nreturn { trimAutoLink: trimAutoLink, gourdAutoLinkExtension: gourdAutoLinkExtension };')();
}

/** 加载仓库内置 marked，并按 app-ui.js 的顺序应用配置与扩展。 */
function loadMarked() {
    const g = {};
    new Function('globalThis', readStatic('js', 'marked.min.js') + '\n')(g);
    assert.ok(g.marked && typeof g.marked.parse === 'function', 'marked.min.js 未挂载 globalThis.marked');
    g.marked.setOptions({ breaks: true, gfm: true });
    g.marked.use(loadAutolinkCore().gourdAutoLinkExtension());
    return g.marked;
}

function linksOf(marked, text) {
    const html = marked.parse(text);
    const out = [];
    const re = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) out.push({ href: m[1], text: m[2] });
    return { html, links: out };
}

test('app-ui.js：扩展定义存在且注册顺序正确（早于 renderMd 定义）', () => {
    const coreStart = appUi.indexOf('/*AUTOLINK-CORE-START*/');
    const reg = appUi.indexOf('marked.use(gourdAutoLinkExtension())');
    const renderMd = appUi.indexOf('function renderMd(text)');
    assert.ok(coreStart > 0, '缺少 AUTOLINK-CORE 扩展定义');
    assert.ok(reg > 0, '缺少 marked.use 注册');
    assert.ok(appUi.indexOf('marked.setOptions') < coreStart, '扩展应注册在 marked.setOptions 之后');
    assert.ok(reg < renderMd, '扩展应在 renderMd 定义前注册，保证流式与一次性渲染同口径');
});

test('事故现场：全角逗号后的中文正文不再被识别进链接', () => {
    const marked = loadMarked();
    const url = 'https://lanhuapp.com/web/#/item/project/stage?tid=f6594edd-e041-4911-aea5-99e0d062630d&pid=6f65241d-9684-48a0-bfb4-1c0374016cd7';
    const text = '$design-lanhu-skill 使用蓝湖skills，现在官网页面需要重构，设计稿在这，' + url + '，去实现官网改版，记住可复用的的接口就复用现在已有的，无法复用、没有的接口需要整理成个md，方便我后续找后端要接口对接';
    const { html, links } = linksOf(marked, text);

    assert.equal(links.length, 1, '只应产出一个链接');
    assert.equal(links[0].href, url, 'href 必须逐字等于原 URL（不得混入中文）');
    assert.equal(links[0].text, url.replace(/&/g, '&amp;'), '链接可见文本就是 URL 本身');
    // 正文回归纯文本：链接之后与之前的中文都不得包在 <a> 内
    assert.ok(html.includes('去实现官网改版'), '后续正文应保留');
    assert.ok(!/<a[^>]*>(?:(?!<\/a>)[\s\S])*去实现官网改版/.test(html), '后续正文不得落入链接内');
    assert.ok(!/%E5%8E%BB|%E5%AE%9E%E7%8E%B0/.test(html), '中文不得被 encodeURI 编进 href');
    assert.ok(html.startsWith('<p>$design-lanhu-skill'), '前导正文保持普通文本');
});

test('边界形态：全角/半角句末标点与括号均截断链接', () => {
    const marked = loadMarked();
    const cases = [
        ['看 https://a.com/x。这段文字', 'https://a.com/x', '。这段文字'],
        ['见 (https://a.com/b)', 'https://a.com/b', ')'],
        ['见 https://a.com/b(c) 结尾', 'https://a.com/b(c)', ' 结尾'],
        ['中文https://a.com/b中文', 'https://a.com/b', '中文'],
        ['两个 https://a.com/1 和 https://b.com/2。', null, null],
    ];
    for (const [text, href, tail] of cases) {
        const { html, links } = linksOf(marked, text);
        if (href) {
            assert.equal(links.length, 1, text);
            assert.equal(links[0].href, href, text);
            assert.ok(html.includes(tail), `${text} → 尾部正文应保留: ${tail}`);
            assert.ok(!/<a[^>]*>[\s\S]*?\u4e2d\u6587/.test(html) || href === 'https://a.com/b', text);
        } else {
            assert.equal(links.length, 2, text);
            assert.deepEqual(links.map(l => l.href), ['https://a.com/1', 'https://b.com/2'], text);
        }
    }
});

test('不误伤：markdown 链接 / 行内代码 / 尖括号 autolink / 邮箱 / www 前缀', () => {
    const marked = loadMarked();

    let { links } = linksOf(marked, '[点我](https://a.com/b) 正常链接');
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://a.com/b');
    assert.equal(links[0].text, '点我', 'markdown 链接的标签文本不得被替换成 URL');

    ({ html, links } = linksOf(marked, '`https://a.com/b` 代码内不建链'));
    assert.equal(links.length, 0, '行内代码内不得建链');
    assert.ok(/<code>https:\/\/a\.com\/b<\/code>/.test(html));

    ({ links } = linksOf(marked, '<https://a.com/b> 尖括号 autolink'));
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://a.com/b', '显式 autolink 保留原语义（不吞尾部）');

    ({ links } = linksOf(marked, '邮箱 a@b.com 保持 mailto'));
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'mailto:a@b.com', '邮箱仍由 marked 内置规则处理');

    ({ links } = linksOf(marked, 'www.example.com/x 开头'));
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'http://www.example.com/x', 'www. 前缀补 http://');

    ({ links } = linksOf(marked, '参数 https://a.com/b?x=1&y=2#frag 完整'));
    assert.equal(links.length, 1);
    assert.equal(links[0].href, 'https://a.com/b?x=1&y=2#frag', 'query 与 hash 不得被裁掉');
});

test('trimAutoLink：句读/引号/星号/未闭合括号裁剪，且保留合法结尾', () => {
    const { trimAutoLink } = loadAutolinkCore();
    const cases = [
        // 注：非 ASCII 字符（汉字/全角标点）在 AUTOLINK_RE 阶段就被挡在 URL 之外，
        //     本函数只处理纯 ASCII 的结尾噪声。
        ['https://a.com/b.', 'https://a.com/b'],
        ['https://a.com/b).', 'https://a.com/b'],
        ['https://a.com/a(b)', 'https://a.com/a(b)'],
        ['https://a.com/a)', 'https://a.com/a'],
        ['https://a.com/b"', 'https://a.com/b'],
        ['https://a.com/b*', 'https://a.com/b'],
        ['https://a.com/b&', 'https://a.com/b'],
        ['https://a.com/p?q=1&', 'https://a.com/p?q=1'],
        ['https://a.com/b#frag', 'https://a.com/b#frag'],
        ['https://a.com/b/', 'https://a.com/b/'],
    ];
    for (const [input, want] of cases) {
        assert.equal(trimAutoLink(input), want, input);
    }
});
