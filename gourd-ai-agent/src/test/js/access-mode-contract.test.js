/*
 * 访问控制档位（会话级双档位）的前端契约。
 *
 * 三个断言族：
 * - 结构契约：两套工具栏都必须有按钮（只加一套会让另一个视图下档位不可用）
 * - 行为契约：切到 full 必须先确认、必须落库、必须随消息携带
 * - 一致性契约：12 个语言包必须齐备且 structure 对齐（缺一个语言就漏一片用户）
 *
 * 风格对齐既有静态契约测试（见 context-selector-contract.test.js）：
 * fs.readFileSync 读源文件做文本断言，不引入 DOM 模拟。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

const chatHtml = readStatic('chat.html');
const settingsHtml = readStatic('settings.html');
const appCss = readStatic('css', 'app.css');
const themeCss = readStatic('css', 'theme.css');
const accessJs = readStatic('js', 'app-access-mode.js');
const bootstrapJs = readStatic('js', 'app-bootstrap.js');
const streamingJs = readStatic('js', 'app-streaming.js');
const settingsJs = readStatic('js', 'app-settings-general.js');

const LOCALES = ['zh-CN', 'zh-TW', 'en', 'de', 'ja', 'ru', 'el', 'es', 'fr', 'pt', 'ro', 'vi'];

test('两套工具栏都必须有权限切换按钮（欢迎页 + 对话页）', () => {
    for (const prefix of ['welcome', 'chat']) {
        assert.match(chatHtml, new RegExp(`id="${prefix}AccessSelector"`), `${prefix} 页缺少权限选择器根节点`);
        assert.match(chatHtml, new RegExp(`id="${prefix}AccessCurrent"`), `${prefix} 页缺少按钮本体`);
        assert.match(chatHtml, new RegExp(`id="${prefix}AccessDropdown"`), `${prefix} 页缺少下拉气泡`);
    }

    // 两套 id 必须不同：两块 DOM 同时存在于同一页面，撞 id 会让事件绑定只命中其中一个
    assert.notEqual(
        chatHtml.match(/id="welcomeAccessSelector"/).index,
        chatHtml.match(/id="chatAccessSelector"/).index
    );
});

test('权限按钮位置照参照稿：欢迎页在输入框托盘条，对话页在 + 按钮之后', () => {
    // 欢迎页（参照稿形态）：权限按钮与项目选择器并排挂在输入框正下方的托盘条
    // （composer-tray，视觉上是输入框的底座），不再挤在工具栏里当盒状 chip。
    const dropZone = chatHtml.indexOf('id="welcomeDropZone"');
    const tray = chatHtml.indexOf('class="composer-tray"');
    const welcomeAccess = chatHtml.indexOf('id="welcomeAccessSelector"');
    assert.ok(dropZone > 0 && tray > dropZone, '托盘条必须在欢迎页输入框之后（底座语义）');
    assert.ok(welcomeAccess > tray, '欢迎页权限按钮必须在托盘条内');
    const trayBlock = chatHtml.slice(tray, chatHtml.indexOf('id="welcomeAccessDropdown"'));
    assert.match(trayBlock, /workspace-selector/, '托盘条必须同时含项目选择器（参照稿双文本按钮）');

    // 欢迎页工具栏不得再残留权限按钮（防止两处同时渲染造成双实例错位）
    const welcomeToolbar = chatHtml.slice(chatHtml.indexOf('class="welcome-toolbar"'), tray);
    assert.ok(!welcomeToolbar.includes('welcomeAccessSelector'), '欢迎页工具栏内不得再放权限按钮');

    // 对话页无托盘条：保持工具栏左区、+ 按钮之后
    const chatPlus = chatHtml.indexOf('chatPlusBtn');
    const chatAccess = chatHtml.indexOf('chatAccessSelector');
    assert.ok(chatPlus > 0 && chatAccess > chatPlus, '对话页权限按钮必须排在 + 按钮之后');
});

test('权限按钮必须是无边框文本按钮（基础形态，参照稿）', () => {
    // 盒状 chip（边框+底色）在工具栏/托盘里读作「另一个控件」，与参照稿的
    // 安静次级入口语言冲突；基础形态 = 透明边框 + 无底色，悬停才浮淡底。
    const baseRule = appCss.match(/\.access-selector-current \{[^}]*\}/);
    assert.ok(baseRule, '缺少权限按钮基础规则');
    assert.match(baseRule[0], /border:\s*1px solid transparent/, '基础形态必须透明边框（hover/full 加底时几何不跳）');
    assert.match(baseRule[0], /background:\s*transparent/, '基础形态必须无底色');
});

test('气泡样式沿用 model-dropdown 的向上弹出参数，且不得套用右区右对齐规则', () => {
    assert.match(appCss, /\.access-dropdown\s*\{[^}]*bottom:\s*100%/,
        '气泡必须向上弹出（bottom:100%），与模型选择器同款');
    assert.match(appCss, /\.access-dropdown\s*\{[^}]*left:\s*0/,
        '气泡左对齐：按钮在工具栏左区，右对齐会溢出屏幕');
    assert.match(appCss, /\.access-selector\.open\s+\.access-dropdown\s*\{\s*display:\s*block/,
        '展开态样式缺失');
    assert.match(appCss, /\.access-selector\.open\s+\.model-arrow\s*\{\s*transform:\s*rotate\(180deg\)/,
        '箭头展开时必须旋转，与 model-selector 观感一致');

    // 反向断言：右区那条 .toolbar-right .model-dropdown{right:0} 不能被套到 access-dropdown 上
    assert.doesNotMatch(appCss, /\.toolbar-right\s+\.access-dropdown/,
        '不得把右对齐规则套到左区的权限气泡上');
});

test('完全访问态必须有独立的高亮样式（与默认态可区分）', () => {
    assert.match(appCss, /\.access-selector\.is-full[^{]*\{[^}]*color:/,
        'full 档必须高亮，否则用户看不出当前处于放行态');
});

test('完全访问态用危险色文本态（无硬边框、无彩色底，参照稿红字）', () => {
    // 两轮用户否决史：硬橙边框读作「报错框」→ 改橙软底仍被点名「丑」。
    // 参照稿终态 = 仅文字与图标转危险色（「允许完全访问」红字），不加任何底色/边框。
    const fullRule = appCss.match(/\.access-selector\.is-full \.access-selector-current \{[^}]*\}/);
    assert.ok(fullRule, '缺少 full 态按钮规则');
    assert.match(fullRule[0], /border-color:\s*transparent/, 'full 态不得保留硬色边框');
    assert.match(fullRule[0], /background:\s*transparent/, 'full 态不得加彩色底（软底已被否决）');
    assert.match(fullRule[0], /color:\s*var\(--color-danger/, 'full 态文字必须用危险色，与参照稿红字一致');
});

test('档位图标必须随状态切换（盾牌=默认 / alert=完全访问）', () => {
    // 纯 CSS 双图标切换：两个 svg 都在 HTML 里，is-full 控制显隐，无需 JS 换图标
    for (const prefix of ['welcome', 'chat']) {
        const block = chatHtml.slice(
            chatHtml.indexOf(`id="${prefix}AccessCurrent"`),
            chatHtml.indexOf(`id="${prefix}AccessDropdown"`)
        );
        assert.match(block, /access-icon-shield/, `${prefix} 页缺少默认态盾牌图标`);
        assert.match(block, /access-icon-alert/, `${prefix} 页缺少完全访问态警示图标`);
    }
    assert.match(appCss, /\.access-selector\.is-full \.access-icon-shield \{ display: none; \}/,
        'full 态必须隐藏盾牌');
    assert.match(appCss, /\.access-selector\.is-full \.access-icon-alert \{ display: block; \}/,
        'full 态必须显示警示图标');
});

test('发送/语音按钮两页规格必须一致，且图标做光学对齐', () => {
    // 用户截图反馈：语音与发送「视觉上不一样大」。根因有二：
    // 1) 欢迎页发送圆 36px、对话页 34px，同屏对比可见大小差；
    // 2) 纸飞机 rotate(-45°) 后包围盒≈svg 的 1.15 倍，麦克风仅≈0.79 倍高，
    //    同名义尺寸下纸飞机显大一圈 → 纸飞机 16px、麦克风 18px 光学对齐。
    // 边界 [^-\w]：防止 .send-btn 先命中 .welcome-send-btn 内部子串
    const welcomeSend = appCss.match(/[^-\w]\.welcome-send-btn \{[^}]*\}/)[0];
    const chatSend = appCss.match(/[^-\w]\.send-btn \{[^}]*\}/)[0];
    const voice = appCss.match(/[^-\w]\.voice-btn \{[^}]*\}/)[0];
    for (const [name, rule] of [['welcome-send', welcomeSend], ['send', chatSend], ['voice', voice]]) {
        assert.match(rule, /width: 34px; height: 34px/, `${name} 圆必须 34px，两页不一致会肉眼可见`);
    }
    assert.match(appCss, /[^-\w]\.welcome-send-btn svg \{ width: 16px; height: 16px/, '欢迎页纸飞机必须 16px');
    assert.match(appCss, /[^-\w]\.send-btn svg \{ width: 16px; height: 16px/, '对话页纸飞机必须 16px');
    assert.match(appCss, /[^-\w]\.voice-btn svg \{ width: 18px; height: 18px/, '麦克风必须 18px 做光学对齐');
});

test('切到完全访问前必须二次确认，且未勾选风险确认时按钮不可用', () => {
    // 这是本功能唯一不可逆的入口：误点等于全面放行，必须有确认闸门
    assert.match(accessJs, /access_confirm_title/, '缺少确认弹窗标题文案');
    assert.match(accessJs, /access_ack/, '缺少风险确认勾选框文案');
    // 风险清单是三块（文件/命令/网络），按 kind 动态取键。
    // 断言不能写成字面量 access_risk_file——源码里是 'app.access_risk_' + kind 拼出来的，
    // 断言源码形态而非行为会写出永远不成立的检查。
    assert.match(accessJs, /riskItemHtml\('file'\)/, '确认弹窗必须列出文件操作风险');
    assert.match(accessJs, /riskItemHtml\('cmd'\)/, '确认弹窗必须列出终端命令风险');
    assert.match(accessJs, /riskItemHtml\('net'\)/, '确认弹窗必须列出访问互联网风险');
    assert.match(accessJs, /disabled/, '未勾选时确认按钮必须禁用');

    // 取消路径必须存在，且不得自动放行
    assert.match(accessJs, /access_cancel/, '缺少取消按钮');
});

test('权限气泡按内容自适应宽度，档位描述必须单行呈现', () => {
    // 用户截图反馈：档位描述被下拉压成两行「丑」。根因 = 气泡宽度被 min/max 夹在 190~288px，
    // 描述可用宽度不足。修复 = width: max-content（按最长行自适应）+ 380px 档封顶。
    const rule = appCss.match(/\.access-dropdown \{[^}]*\}/);
    assert.ok(rule, '缺少权限气泡规则');
    assert.match(rule[0], /width: max-content/, '气泡必须按内容自适应宽度，否则描述被压成两行');
    assert.match(rule[0], /max-width: var\(--dropdown-w-max\)/, '气泡必须以宽面板档封顶（长语种到顶才允许换行）');
});

test('档位描述长度预算：12 语言都必须能单行呈现', () => {
    // 气泡封顶 380px，描述可用宽度 ≈330px（11px 字号）。按「CJK 记 2、其余记 1」加权，
    // 预算 60 单位（≈330px）——超限即意味着又回到两行换行（用户已否决的形态）。
    for (const lang of LOCALES) {
        const json = JSON.parse(readStatic('locales', `${lang}.json`));
        for (const key of ['access_default_desc', 'access_full_desc']) {
            const text = json.app[key];
            const weight = [...text].reduce((n, ch) => n + (/[\u2E80-\uFFFD]/.test(ch) ? 2 : 1), 0);
            assert.ok(weight <= 60, `${lang} 的 app.${key} 加权长度 ${weight} 超预算（会换行）：${text}`);
        }
    }
});

test('确认弹窗风险清单为「图标行」形态（图标块 + 名称 + 说明）', () => {
    // 参照稿形态：三行扁平图标行；旧 amber 卡片堆叠已废弃（与弹窗底再叠一层盒子）。
    assert.match(accessJs, /var RISK_ICONS = \{/, '缺少风险图标表');
    for (const kind of ['file', 'cmd', 'net']) {
        assert.match(accessJs, new RegExp(kind + ":\\s*'<svg"), `${kind} 风险行缺少图标`);
    }
    assert.match(accessJs, /class="access-risk-icon"/, '风险行缺少图标容器');

    const itemRule = appCss.match(/\.access-risk-item \{[^}]*\}/);
    assert.ok(itemRule, '缺少风险行样式');
    assert.match(itemRule[0], /display: flex/, '风险行必须为横向图标行布局');
    assert.match(itemRule[0], /gap: 10px/, '图标与文本间距缺失');
    const iconRule = appCss.match(/\.access-risk-icon \{[^}]*\}/);
    assert.ok(iconRule, '缺少风险图标块样式');
    assert.match(iconRule[0], /width: 28px; height: 28px/, '图标块必须 28px 规格');
});

test('「允许完全访问」按钮为危险色实底 + 内嵌警示图标', () => {
    // 弹窗里唯一的不可逆动作：参照稿取警示语义（红字/红底确认），且图标不得被翻译顶掉。
    const btnRule = appCss.match(/\.access-confirm-btns \.access-allow-btn \{[^}]*\}/);
    assert.ok(btnRule, '缺少确认按钮危险色样式');
    assert.match(btnRule[0], /background: var\(--color-danger\)/, '确认按钮必须危险色实底');
    assert.match(btnRule[0], /display: inline-flex/, '图标 + 文字必须弹性排布');
    assert.match(appCss, /\.access-confirm-btns \.access-allow-btn:hover/, '缺少悬停态（hover 色应更深）');

    const allowIdx = accessJs.indexOf('access-allow-btn');
    const allowBlock = accessJs.slice(allowIdx, allowIdx + 900);
    assert.match(allowBlock, /<svg/, '确认按钮必须内嵌警示图标');
    assert.match(allowBlock, /<span data-i18n="app\.access_allow">/, '按钮文案必须挂在内层 span 上（图标 svg 不被 translateDOM 顶掉）');
});

test('警示软底令牌成套定义（明暗各一），组件引用令牌而非颜色字面量', () => {
    // 色彩治理约定：全站颜色字面量只允许出现在 theme.css；组件一律引用 token。
    assert.match(themeCss, /\[data-theme="light"\][\s\S]*?--bg-warning-subtle:/, '亮色主题缺少 --bg-warning-subtle');
    assert.match(themeCss, /\[data-theme="dark"\][\s\S]*?--bg-warning-subtle:/, '暗色主题缺少 --bg-warning-subtle');
    assert.match(appCss, /\.access-risk-icon \{[^}]*background: var\(--bg-warning-subtle\)/, '风险图标块必须引用警示软底令牌');
    assert.match(appCss, /\.access-option\.active\.is-full \{[^}]*background: var\(--bg-warning-subtle\)/, '档位选中态必须引用警示软底令牌');
    assert.doesNotMatch(appCss, /\.access-option\.active\.is-full \{[^}]*rgba\(245, 158, 11/, '档位选中态不得残留颜色字面量');
});

test('切换必须持久化到后端，失败要回滚而不是假装成功', () => {
    assert.match(accessJs, /\/web\/chat\/access\/select/, '必须调用持久化端点');
    assert.match(accessJs, /accessMode/, '持久化请求必须带 accessMode');
    // 失败回滚：否则刷新后档位与界面不一致，用户以为开了完全访问其实没有
    assert.match(accessJs, /access_failed/, '缺少失败提示文案');
});

test('档位必须随消息发送携带，否则切了也不生效', () => {
    assert.match(streamingJs, /formData\.append\('accessMode'/,
        '发送路径必须携带 accessMode，否则后端收不到本轮档位');
    assert.match(streamingJs, /modeForSession/,
        '取值必须按会话查（而非读全局当前值），避免切换会话与发送竞态时带错档位');
});

test('新会话回到默认权限，同一会话重开保持', () => {
    // inheritSelectionToSession 刻意不继承 accessMode：新会话必须回到默认档
    const historyJs = readStatic('js', 'app-history.js');
    const inheritBody = historyJs.slice(
        historyJs.indexOf('function inheritSelectionToSession'),
        historyJs.indexOf('function inheritSelectionToSession') + 900
    );
    assert.doesNotMatch(inheritBody, /accessMode|GourdAccessMode/,
        '新会话不得继承完全访问档：那会让用户在一个没确认过的会话里处于放行态');

    assert.match(accessJs, /sessionAccessMap/, '缺少会话级档位缓存（同一会话重开需保持）');
});

test('模块必须被加载，且接入浮层互斥', () => {
    assert.match(bootstrapJs, /app-access-mode\.js/, '模块未注册到脚本清单，等于没写');
    assert.match(accessJs, /closeAllToolbarPanels/,
        '展开前必须收起其它浮层，否则多个气泡同时打开');

    const historyJs = readStatic('js', 'app-history.js');
    assert.match(historyJs, /\.access-selector'\)\.removeClass\('open'\)/,
        'closeAllToolbarPanels 必须能收起权限气泡（反向互斥）');
});

test('设置页的沙盒模式卡片及其字段已彻底移除', () => {
    assert.doesNotMatch(settingsHtml, /generalSandbox/,
        '设置页仍残留沙盒开关，与档位功能重复');
    assert.doesNotMatch(settingsHtml, /settings\.general\.sandbox/,
        '设置页仍残留沙盒文案键');

    // 这三个 id 的收集/回填/监听都必须清掉：settings 保存是全量提交，
    // 留着空字段会把配置写成 undefined 或让回填错位
    assert.doesNotMatch(settingsJs, /generalSandbox/,
        '设置 JS 仍引用已删除的沙盒字段，会导致全量提交写入脏值');
});

/* ===== 行为契约（vm 沙箱跑真模块，替代纯字符串断言） =====
   背景：纯文本断言（匹配 /\/web\/chat\/access\/select/）在「删掉 $.post 调用」的变异下
   仍然全绿（URL 常量定义还在）。这里把整个 IIFE 放进 vm 上下文、以最小 jQuery 桩驱动，
   断言真实调用与回滚行为。 */
const vm = require('node:vm');

function loadAccessModule(postImpl, sessionId) {
    const sid = sessionId || 'sess-vm';
    const posts = [];
    const toasts = [];
    const chain = { length: 0 };
    for (const m of ['each', 'find', 'toggleClass', 'attr', 'text', 'html', 'removeClass',
        'addClass', 'on', 'not', 'toggle', 'prop', 'closest', 'val', 'is']) {
        chain[m] = () => chain;
    }
    const $ = () => chain;
    $.post = (url, data) => {
        posts.push({ url, data });
        return postImpl ? postImpl(url, data) : { done(cb) { cb({ code: 200 }); return this; }, fail() { return this; } };
    };
    $.get = () => ({ fail() { return this; } });

    const win = {
        showToast: (msg, kind) => toasts.push({ msg, kind }),
        SESSION_ID: sid,
    };
    const sandbox = {
        window: win,
        document: { addEventListener: () => { } },
        $,
        console: { error: () => { }, warn: () => { } },
        setTimeout: () => 0,
        clearTimeout: () => { },
    };
    vm.runInNewContext(accessJs, sandbox, { filename: 'app-access-mode.js' });
    return { api: win.GourdAccessMode, posts, toasts };
}

test('切换档位必须真的发起持久化请求（行为断言，非字符串匹配）', () => {
    const { api, posts } = loadAccessModule(null, 'sess-1');
    assert.ok(api, '模块必须导出 GourdAccessMode');

    api.onSessionSwitch('sess-1');
    api.setMode('full');

    assert.equal(posts.length, 1, '切换必须且仅发起一次持久化请求');
    assert.equal(posts[0].url, '/web/chat/access/select');
    assert.equal(posts[0].data.sessionId, 'sess-1');
    assert.equal(posts[0].data.accessMode, 'full');
    assert.equal(api.getMode(), 'full');
});

test('持久化失败必须回滚档位，而不是假装成功', () => {
    const { api, toasts } = loadAccessModule(() => ({
        done(cb) { cb({ code: 500 }); return this; },
        fail() { return this; },
    }), 'sess-2');

    api.onSessionSwitch('sess-2');
    api.setMode('full');

    assert.equal(api.getMode(), 'default', '后端拒绝后必须回滚到原档位');
    assert.equal(api.modeForSession('sess-2'), 'default', '会话缓存也必须一并回滚，否则发送路径仍带 full');
    assert.ok(toasts.some(t => t.kind === 'error'), '必须给出失败提示');
});

test('网络层失败（fail 分支）同样回滚', () => {
    const { api } = loadAccessModule(() => ({
        done() { return this; },
        fail(cb) { cb({ status: 0 }); return this; },
    }), 'sess-3');

    api.onSessionSwitch('sess-3');
    api.setMode('full');

    assert.equal(api.getMode(), 'default', '网络失败不得留下「界面显示 full、后端仍是 default」的割裂态');
});

test('12 个语言包均提供档位文案，且不再含沙盒键', () => {
    for (const lang of LOCALES) {
        const raw = readStatic('locales', `${lang}.json`);
        let json;
        try {
            json = JSON.parse(raw);
        } catch (e) {
            assert.fail(`${lang}.json 不是合法 JSON: ${e.message}`);
        }

        assert.equal(typeof json.app, 'object', `${lang} 缺少 app 段`);
        for (const key of ['access_default', 'access_full', 'access_title', 'access_confirm_title']) {
            assert.equal(typeof json.app[key], 'string', `${lang} 缺少 app.${key}`);
            assert.ok(json.app[key].length > 0, `${lang} 的 app.${key} 为空`);
        }

        assert.equal(json.settings?.general?.sandbox, undefined,
            `${lang} 仍残留 settings.general.sandbox 文案`);
    }
});
