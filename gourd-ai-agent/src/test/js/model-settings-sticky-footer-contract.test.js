/* ===== model-settings-sticky-footer-contract.test.js =====
   模型配置页主操作布局契约。

   背景（用户报障）：新增服务商表单里，「添加供应商」主按钮原本排在右栏滚动流的
   最末端（.model-settings-form-wrap > .form-actions）。从 API 拉取上百个模型后
   列表把按钮顶到很远的地方，每次都要滚到底才能提交。

   第一版修复（吸底）：左右两栏各加一个吸底区，两个按钮都常驻卡片底部。
   实测暴露出新问题——两个按钮文案完全一致（都叫「添加服务商」）、同一水平带并排，
   语义与视觉双重重复；且编辑态右栏 footer 隐藏、左栏 footer 仍占 60px，底部左右不对称；
   左栏那个按钮在填表途中被误点会静默清空表单。

   最终形态（用户拍板方案A）：
   - 左栏顶部头部区：分组标题 + 「+」图标按钮 = 列表级「新建」入口；
   - 右栏底部吸底区：实心主按钮「创建服务商」= 表单提交动作。
   两者不在同一区域、不同文案、不同视觉重量，不再重复。

   注意：本仓工作树是 CRLF（git i/lf w/crlf），锚点里不要写 '\n' 字面量。
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8').replace(/^\uFEFF/, '');

const html = read('model-settings.html');
const css = read('css', 'model-settings.css');
const js = read('js', 'app-model-settings.js');

/** 行尾归一，便于做跨行结构断言 */
const norm = (s) => s.replace(/\r\n/g, '\n');

/* ===================== HTML：新建入口在左栏顶部，提交在右栏底部 ===================== */

test('左栏：新建入口位于头部区，不在滚动区内（供应商再多也不用滚到底）', () => {
    const src = norm(html);
    const headerStart = src.indexOf('<div class="model-settings-left-header">');
    const scrollStart = src.indexOf('<div class="model-settings-left-scroll">');
    assert.ok(headerStart >= 0, '未找到左栏头部区 .model-settings-left-header');
    assert.ok(scrollStart > headerStart, '左栏头部必须先于滚动区出现在 DOM 中');

    // 入口按钮在头部区内部（head 起点到 scroll 起点之间）
    const between = src.slice(headerStart, scrollStart);
    assert.ok(between.includes('id="msProviderAddBtn"'),
        '新建入口按钮必须在左栏头部区内（列表级操作不放滚动流末端）');

    // 且不在滚动区内
    const scrollEnd = src.indexOf('<!-- 右栏：详情/表单 -->', scrollStart);
    const scrollInner = src.slice(scrollStart, scrollEnd > 0 ? scrollEnd : undefined);
    assert.ok(!scrollInner.includes('id="msProviderAddBtn"'),
        '新建入口不得留在左栏滚动区内（供应商一多就要滚到底）');
});

test('左栏：已移除底部吸底区（新建入口不再与右栏提交同带并排）', () => {
    assert.ok(!norm(html).includes('model-settings-left-footer'),
        '左栏底部吸底区应已移除：新建入口移到头部，底部只保留右栏提交按钮');
});

test('右栏：提交行在 .model-settings-form-wrap 之外，位于吸底操作栏', () => {
    const src = norm(html);
    const wrapStart = src.indexOf('<div class="model-settings-form-wrap">');
    assert.ok(wrapStart >= 0, '未找到右栏表单滚动容器');
    const footerStart = src.indexOf('<div class="model-settings-footer" id="msProviderFormSubmitRow">');
    assert.ok(footerStart > wrapStart, '吸底操作栏必须位于右栏滚动容器之后（DOM 同级、滚动区之外）');
    // 滚动区（form-wrap 起点到吸底区起点之间）不得含提交按钮
    const between = src.slice(wrapStart, footerStart);
    assert.ok(!between.includes('id="msProviderSaveBtn"'),
        '提交按钮不得留在 .model-settings-form-wrap 滚动区内（上百模型后要滚到底才能点）');
    assert.match(src, /<div class="model-settings-footer" id="msProviderFormSubmitRow">\s*\n\s*<button class="btn-primary" id="msProviderSaveBtn"/,
        '提交按钮必须是吸底操作栏的直接子节点');
    // 旧的滚动流内提交行（form-actions-end）必须已移除，避免双份按钮
    assert.ok(!src.includes('form-actions-end'),
        '旧的 .form-actions.form-actions-end 提交行应已移除（否则出现两个提交按钮）');
});

test('提交行仍在右栏内（不越级到卡片外）', () => {
    const src = norm(html);
    const rightStart = src.indexOf('<div class="model-settings-right">');
    const footerStart = src.indexOf('id="msProviderFormSubmitRow"');
    assert.ok(rightStart >= 0 && footerStart > rightStart,
        '吸底操作栏必须在 .model-settings-right 内部（右栏跟随列布局才能贴底）');
});

test('吸底区不承载任何表单字段（只放主操作，避免滚出视野）', () => {
    const src = norm(html);
    const footer = src.match(/<div class="model-settings-footer" id="msProviderFormSubmitRow">([\s\S]*?)\n\s{20}<\/div>/);
    assert.ok(footer, '未找到吸底操作栏内容');
    assert.ok(!/<input|<select|<textarea/.test(footer[1]),
        '吸底操作栏不得包含输入控件（表单字段必须在滚动区内）');
});

/* ===================== 语义分层：两个按钮不得同名 ===================== */

test('两个按钮文案必须不同（曾同名「添加服务商」并排，用户无法判断点哪个会创建）', () => {
    const src = norm(html);
    const addKey = src.match(/id="msProviderAddBtn"[\s\S]*?data-i18n-title="([^"]+)"/);
    const saveKey = src.match(/id="msProviderSaveBtn"\s+data-i18n="([^"]+)"/);
    assert.ok(addKey, '未找到新建入口按钮的 i18n key');
    assert.ok(saveKey, '未找到提交按钮的 i18n key');

    // 左栏入口不再使用 settings.providers.add（那是「添加服务商」动词短语）
    assert.notStrictEqual(addKey[1], saveKey[1],
        '新建入口与表单提交不得共用同一个 i18n key（否则按钮文字完全一样）');
    assert.strictEqual(saveKey[1], 'settings.providers.create',
        '表单提交按钮文案应为明确的创建动词 settings.providers.create');

    // 左栏入口是纯图标按钮：只有 data-i18n-title（tooltip），不写可见文字
    const addBtnHtml = src.match(/<button class="model-settings-add-btn" id="msProviderAddBtn"[\s\S]*?<\/button>/);
    assert.ok(addBtnHtml, '未找到新建入口按钮完整标签');
    assert.ok(!/data-i18n="/.test(addBtnHtml[0]),
        '新建入口为图标按钮，不应带可见文字 data-i18n（否则又变成第二个「添加服务商」）');
});

test('locale：settings.providers.create 在全部语言包中存在且非空', () => {
    const dir = path.join(STATIC, 'locales');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 12, '语言包数量异常');
    const missing = [];
    files.forEach((f) => {
        const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, ''));
        const v = dict.settings && dict.settings.providers && dict.settings.providers.create;
        if (typeof v !== 'string' || !v.trim()) missing.push(f);
    });
    assert.deepStrictEqual(missing, [],
        '以下语言包缺少 settings.providers.create：' + missing.join(', '));
});

/* ===================== CSS：布局与视觉分层 ===================== */

test('CSS：左栏为 flex 列，头部区 flex-shrink:0 常驻', () => {
    assert.match(css, /\.model-settings-left \{[\s\S]*?display: flex; flex-direction: column;/,
        '左栏必须为 flex 列布局（头部固定 + 滚动区 flex:1）');
    assert.match(css, /\.model-settings-left-header \{\s*\n\s*flex-shrink: 0;/,
        '左栏头部必须 flex-shrink:0，否则被上方/下方内容挤压');
});

test('CSS：新建入口为轻量图标按钮（与右侧实心主按钮形成主次层级）', () => {
    const block = css.match(/\.model-settings-add-btn \{[\s\S]*?\n\}/);
    assert.ok(block, '未找到 .model-settings-add-btn 样式块');
    assert.match(block[0], /width: 26px; height: 26px;/,
        '新建入口应为小尺寸图标按钮（不是全宽虚线大按钮）');
    assert.match(block[0], /background: transparent;/,
        '新建入口应无填充，避免与实心主按钮争夺视觉焦点');
});

test('CSS：已移除旧的虚线全宽添加按钮样式', () => {
    assert.ok(!css.includes('.model-settings-add-provider-btn'),
        '旧的 .model-settings-add-provider-btn 样式应已移除（按钮已改为头部图标按钮）');
});

test('CSS：右栏吸底操作栏 flex-shrink:0 + 顶部分隔线 + 右对齐', () => {
    assert.match(css, /\.model-settings-right \{[^}]*display: flex; flex-direction: column;/,
        '右栏必须为 flex 列布局');
    assert.match(css, /\.model-settings-footer \{\s*\n\s*flex-shrink: 0;/,
        '右栏吸底区必须 flex-shrink:0');
    assert.match(css, /\.model-settings-footer \{[^}]*justify-content: flex-end;/,
        '主操作按钮保持右侧对齐（与旧 form-actions-end 一致的视觉位置）');
    assert.match(css, /\.model-settings-footer \{[^}]*border-top: 1px solid var\(--border-color\);/,
        '右栏吸底区需要顶部分隔线');
});

test('CSS：滚动仍由列表/表单容器承担（未被布局改造破坏）', () => {
    assert.match(css, /\.model-settings-left-scroll \{ flex: 1; overflow-y: auto;/);
    assert.match(css, /\.model-settings-form-wrap \{ flex: 1; overflow-y: auto;/);
});

test('CSS：窄屏堆叠布局下吸底区不吃卡片圆角', () => {
    const media = css.slice(css.indexOf('@media (max-width: 860px)'));
    assert.match(media, /\.model-settings-footer \{ border-radius: 0 0 12px 12px; \}/,
        '窄屏时吸底区是文档流末项，底部圆角需跟随卡片');
});

/* ===================== JS：切换供应商/新增态时右栏回顶 ===================== */

test('selectAdd 切换新增表单后右栏滚动位置归零', () => {
    const start = js.indexOf('function selectAdd()');
    const end = js.indexOf('function selectProvider', start);
    assert.ok(start >= 0 && end > start, '未找到 selectAdd 函数');
    const block = js.slice(start, end);
    assert.match(block, /renderDetailForm\(null\);\s*\n\s*resetFormScroll\(\);/,
        '进入新增表单必须回顶，否则沿用上一家供应商的滚动位置');
});

test('selectAdd 幂等：已在新增态时不得重绘（否则误点入口清空已填表单）', () => {
    const start = js.indexOf('function selectAdd()');
    const end = js.indexOf('function selectProvider', start);
    assert.ok(start >= 0 && end > start, '未找到 selectAdd 函数');
    const block = js.slice(start, end);
    assert.match(block, /if \(selectedName === '__add__' && currentProvider === null\) return;/,
        'selectAdd 必须对「已在新增态」做幂等短路：新建入口在列表顶部，' +
        '填表途中极易被误点，重绘会静默清空已填的名称/地址/密钥');
});

test('selectProvider 切换供应商后右栏滚动位置归零', () => {
    const start = js.indexOf('function selectProvider(name)');
    const end = js.indexOf('function fillDetailFromCache', start);
    assert.ok(start >= 0 && end > start, '未找到 selectProvider 函数');
    const block = js.slice(start, end);
    assert.match(block, /fillDetailFromCache\(name\);\s*\n\s*resetFormScroll\(\);/,
        '切换供应商必须回顶，否则新表单从中段开始、标题与地址看不到');
});

test('resetFormScroll 作用于右栏表单滚动容器', () => {
    const start = js.indexOf('function resetFormScroll()');
    assert.ok(start >= 0, '未找到 resetFormScroll 函数');
    const block = js.slice(start, js.indexOf('\n    }', start));
    assert.match(block, /\.model-settings-form-wrap/);
    assert.match(block, /scrollTop = 0;/);
});

/* 窄屏堆叠（<=860px）时 .model-settings-form-wrap 被改成 overflow:visible、
   不再滚动，整页滚动交给外层 .model-settings-scroll。若只清 wrap 的滚动位置，
   换供应商后标题仍停在视口上方（实测 120 个模型时标题位于 -2445px）。 */
test('resetFormScroll 同时归零外层页面滚动容器（窄屏堆叠布局下唯一滚动区）', () => {
    const start = js.indexOf('function resetFormScroll()');
    assert.ok(start >= 0, '未找到 resetFormScroll 函数');
    const block = js.slice(start, js.indexOf('\n    }', start));
    assert.match(block, /\.model-settings-scroll/,
        '窄屏下外层 .model-settings-scroll 才是滚动容器，必须一并归零');
    const wrapIdx = block.indexOf('.model-settings-form-wrap');
    const pageIdx = block.indexOf('.model-settings-scroll');
    assert.ok(wrapIdx >= 0 && pageIdx > wrapIdx, '两处滚动容器都要处理（wrap + 外层页面）');
});

test('CSS 契约：窄屏确实把 wrap 改为 overflow:visible（此前提成立）', () => {
    const media = css.slice(css.indexOf('@media (max-width: 860px)'));
    assert.match(media, /\.model-settings-form-wrap \{ overflow: visible; \}/,
        '窄屏下 wrap 不再滚动，因此 resetFormScroll 必须兼顾外层滚动容器');
});

/* ===================== JS：编辑/新增态切换口径不变 ===================== */

test('编辑态隐藏吸底操作栏、新增态显示（toggle 口径未变）', () => {
    assert.match(js, /\$\('#msProviderFormSubmitRow'\)\.toggle\(!provider\);/,
        '吸底操作栏显隐仍由新增/编辑态驱动');
});

test('保存按钮绑定与 ID 未变（HTML 迁移不影响事件接线）', () => {
    assert.match(js, /\$\('#msProviderSaveBtn'\)\.on\('click', function \(\) \{\s*\n\s*saveProvider\(\);/);
    assert.match(js, /\$\('#msProviderAddBtn'\)\.on\('click', function \(\) \{\s*\n\s*selectAdd\(\);/);
});
