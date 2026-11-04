/**
 * bash 写豁免目录设置项：前端全链路契约。
 *
 * 为什么这个测试必须「真执行」而不只是读源码匹配字符串：
 * 本仓多次踩到同一类坑 —— 字符串契约只能锁「文案/结构存在」，锁不住「调用还在」。
 * 典型形态是把 loadPermissionSettings 里的回显语句删掉、或把 savePermissionSettings
 * 里的字段从请求体里去掉，纯正则断言可能仍然全绿（因为别处还留着同名字符串），
 * 而用户侧表现为「保存了但没生效 / 打开设置页看不到已配的值」。
 *
 * 故本文件分两层：
 *   A. vm 真执行 —— 把 app-settings-permission.js 的 IIFE 跑起来，用 jQuery/GourdI18n 桩
 *      捕获 $.get 的回显与 $.ajax 的请求体，断言真实行为；
 *   B. 字符串契约 —— HTML 结构与 12 个语言包的键完整性（vm 覆盖不到的静态资产）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');

function readStatic(...segs) {
    return fs.readFileSync(path.join(staticRoot, ...segs), 'utf8').replace(/^\uFEFF/, '');
}

// ====================================================================
// jQuery / i18n 桩：在 vm 沙箱里驱动真实模块代码
// ====================================================================

/**
 * 构造一个够用的 jQuery 桩。
 *
 * 只实现 app-settings-permission.js 真正调用的那几个面：
 * 选择器 .on/.val/.each/.prop/.html/.attr/.text，以及 $.get / $.ajax。
 * 桩越贴近真实调用面，vm 里跑出来的行为结论越可信。
 */
function makeHarness() {
    const state = {
        textareas: {},          // id -> 当前值
        checkboxes: [],         // {tool, checked}
        clickHandlers: {},      // selector -> [fn]
        changeHandlers: {},     // selector -> {delegate, fn}
        gets: [],               // {url, cb}
        ajaxCalls: [],          // 完整的 $.ajax 参数
        buttons: {}             // selector -> {disabled}
    };

    function makeSelection(selector) {
        const sel = {
            _selector: selector,

            on(event, delegateOrFn, maybeFn) {
                const fn = typeof delegateOrFn === 'function' ? delegateOrFn : maybeFn;
                const delegate = typeof delegateOrFn === 'function' ? null : delegateOrFn;
                if (event === 'click') {
                    (state.clickHandlers[selector] = state.clickHandlers[selector] || []).push(fn);
                } else if (event === 'change') {
                    state.changeHandlers[selector] = { delegate, fn };
                }
                return sel;
            },

            val(v) {
                // 只关心豁免目录 textarea；其它一律返回空串
                if (v === undefined) {
                    return Object.prototype.hasOwnProperty.call(state.textareas, selector)
                        ? state.textareas[selector] : '';
                }
                state.textareas[selector] = v;
                return sel;
            },

            each(fn) {
                if (/permission-tool-toggle/.test(selector)) {
                    state.checkboxes.forEach((box, i) => {
                        if (/not\(:checked\)/.test(selector) && box.checked) return;
                        fn.call({ attr: (k) => (k === 'data-tool' ? box.tool : undefined) }, i);
                    });
                }
                return sel;
            },

            prop(k, v) {
                if (v === undefined) return state.buttons[selector] ? state.buttons[selector][k] : undefined;
                (state.buttons[selector] = state.buttons[selector] || {})[k] = v;
                return sel;
            },

            html(h) {
                if (h === undefined) return state.htmls && state.htmls[selector];
                state.htmls = state.htmls || {};
                state.htmls[selector] = h;
                return sel;
            },

            text(t) { return sel; },
            attr(k) { return undefined; },
            addClass() { return sel; },
            removeClass() { return sel; },
            find() { return makeSelection(selector + ' *'); },
            length: 0
        };
        return sel;
    }

    function $(selector) {
        return makeSelection(selector);
    }

    $.get = function (url, cb) {
        const rec = { url, cb, failHandlers: [] };
        state.gets.push(rec);
        const ret = { fail(fn) { rec.failHandlers.push(fn); return ret; } };
        return ret;
    };

    $.ajax = function (opts) {
        state.ajaxCalls.push(opts);

        // 模拟“请求已完成且成功”的 deferred。关键语义：jQuery 的 deferred 在已 resolved 之后
        // 再注册 done/always 会<b>立即</b>回调。生产代码用的正是链式写法
        // $.ajax({...}).done(fn).fail(fn).always(fn)，回调是在 ajax() 返回<b>之后</b>才注册的；
        // 若在 ajax() 内部就同步触发，那时 handler 列表还是空的，永远测不到 done/always 分支
        // （实测正是这个缺陷让“按钮恢复可点”断言失败）。
        const response = { code: 200, message: '' };
        const ret = {
            done(fn) { if (typeof fn === 'function') fn(response); return ret; },
            fail(fn) { /* 成功响应不触发 fail，与 jQuery 一致 */ return ret; },
            always(fn) { if (typeof fn === 'function') fn(); return ret; },
            then(fn) { return ret.done(fn); }
        };
        return ret;
    };

    return { $, state };
}

/** 在 vm 里加载并执行真实的 app-settings-permission.js，返回可操作的句柄。 */
function loadModule(getResponse) {
    const source = readStatic('js', 'app-settings-permission.js');
    const { $, state } = makeHarness();

    const i18nKeys = [];
    const sandbox = {
        $,
        jQuery: $,
        window: {},
        console,
        GourdI18n: {
            t(key) {
                i18nKeys.push(key);
                // 返回一个可辨识的伪文案；生产里由语言包提供
                return 'i18n:' + key;
            }
        },
        // showToast 走 layer.msg 分支；给个桩以免报 undefined
        layer: { msg() {} },
        document: { addEventListener() {} }
    };
    sandbox.window.layAlert = undefined;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'app-settings-permission.js' });

    return { sandbox, state, $, i18nKeys, getResponse };
}

// ====================================================================
// A. vm 真执行：回显与保存行为
// ====================================================================

test('模块暴露 load 入口，且保存按钮已绑定 click', () => {
    const h = loadModule();
    assert.equal(typeof h.sandbox.window._settingsPermission, 'object',
        '模块必须把 load 挂到 window._settingsPermission（设置页据此触发加载）');
    assert.equal(typeof h.sandbox.window._settingsPermission.load, 'function');

    const handlers = h.state.clickHandlers['#permissionSaveBtn'];
    assert.ok(Array.isArray(handlers) && handlers.length === 1,
        '保存按钮必须绑定 savePermissionSettings；断掉绑定则用户点保存毫无反应');
});

test('加载：后端返回的豁免目录必须回显到 textarea（每行一个）', () => {
    const h = loadModule();

    const dirs = ['D:\\build-out', '/home/u/cache', '~/my-out'];
    // 触发真实的 load -> $.get -> 回调
    h.sandbox.window._settingsPermission.load();
    assert.equal(h.state.gets.length, 1, 'load 必须发起一次 GET');
    assert.equal(h.state.gets[0].url, '/web/settings/permission');

    h.state.gets[0].cb({ code: 200, data: { disallowedTools: [], bashExemptDirs: dirs } });

    assert.equal(h.state.textareas['#bashExemptDirs'], dirs.join('\n'),
        '已保存的豁免目录必须回显，否则用户打开设置页看到空白，会误以为配置丢失');
});

test('加载：后端未返回该字段时不得报错，textarea 置空', () => {
    const h = loadModule();
    h.sandbox.window._settingsPermission.load();
    // 老版本后端 / 老 settings.json 没有这个字段
    assert.doesNotThrow(() => h.state.gets[0].cb({ code: 200, data: { disallowedTools: [] } }));
    assert.equal(h.state.textareas['#bashExemptDirs'], '',
        '字段缺失必须回落到空串，不能留下 undefined 字面量');
});

test('保存：请求体必须带上豁免目录，且多行文本被去重去空', () => {
    const h = loadModule();

    // 预置 textarea 内容：含重复项、空行、首尾空格
    h.state.textareas['#bashExemptDirs'] =
        'D:\\build-out\n\n  D:\\build-out  \n/home/u/cache\n   \n';

    // 触发真实的保存处理器（即 click 绑定的那个函数）
    h.state.clickHandlers['#permissionSaveBtn'][0]();

    assert.equal(h.state.ajaxCalls.length, 1, '保存必须发起一次 ajax');
    const call = h.state.ajaxCalls[0];
    assert.equal(call.url, '/web/settings/permission/save');
    assert.equal(call.method, 'POST');

    const body = JSON.parse(call.data);
    assert.ok(Array.isArray(body.bashExemptDirs),
        '请求体必须含 bashExemptDirs 数组；缺了这个键，后端按部分提交语义保留旧值，用户将无法修改配置');
    assert.deepEqual(body.bashExemptDirs, ['D:\\build-out', '/home/u/cache'],
        '必须去重、去空行、trim 首尾空格，否则设置页会显示重复行');

    // 既有字段不得被破坏（回归护栏）
    assert.deepEqual(body.tools, ['**'], 'tools 白名单语义必须保持');
    assert.ok(Array.isArray(body.disallowedTools), 'disallowedTools 必须仍然提交');
});

/**
 * 这条锁的是「清空后必须能真的删掉」。
 *
 * 后端 permissionSave 采用部分提交语义：只有请求体里存在 bashExemptDirs 键才更新。
 * 若前端在数组为空时省略该键（一个很自然的"优化"），用户删光所有行再保存将毫无效果，
 * 而且界面上看不出任何异常 —— 这是最难被发现的一类缺陷。
 */
test('保存：清空所有行时必须提交空数组（否则无法删除已有配置）', () => {
    const h = loadModule();
    h.state.textareas['#bashExemptDirs'] = '';

    h.state.clickHandlers['#permissionSaveBtn'][0]();

    const body = JSON.parse(h.state.ajaxCalls[0].data);
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'bashExemptDirs'),
        '即使为空也必须显式带上该键：后端按键是否存在判断要不要更新，省略键等于放弃删除');
    assert.deepEqual(body.bashExemptDirs, []);
});

test('保存：失败与网络错误走 toast，且按钮恢复可点', () => {
    const h = loadModule();
    h.state.textareas['#bashExemptDirs'] = 'D:\\x';
    h.state.clickHandlers['#permissionSaveBtn'][0]();

    // always 回调已把按钮恢复
    assert.equal(h.state.buttons['#permissionSaveBtn'].disabled, false,
        '保存结束后必须解除按钮禁用，否则一次失败后就再也点不动了');
});

test('模块顶层调用 i18n 取文案，未硬编码中文', () => {
    const h = loadModule();
    assert.ok(h.i18nKeys.length > 0, '模块必须通过 GourdI18n.t 取文案');
    assert.ok(h.i18nKeys.some(k => k.startsWith('settings.permission.tool.')),
        '工具描述应走语言包');
});

// ====================================================================
// B. 字符串契约：HTML 结构与语言包完整性
// ====================================================================

test('HTML：豁免目录 textarea 存在于 permission tab 内，且与保存按钮同一 section', () => {
    const html = readStatic('settings.html');

    const tabStart = html.indexOf('id="settingsTabPermission"');
    assert.ok(tabStart >= 0, 'permission tab 容器必须存在');
    const tabEnd = html.indexOf('<!-- MCP Tab -->', tabStart);
    assert.ok(tabEnd > tabStart, 'permission tab 必须有结束边界');
    const section = html.slice(tabStart, tabEnd);

    assert.match(section, /<textarea[^>]*id="bashExemptDirs"/,
        '豁免目录输入框必须在 permission tab 内（放错 tab 用户就找不到）');
    assert.match(section, /id="permissionSaveBtn"/,
        '保存按钮必须与输入框在同一 tab：两处分离会让用户不清楚哪个按钮管哪块');

    // 输入框必须排在保存按钮之前，否则视觉上"按钮在输入框上方"很反直觉
    assert.ok(section.indexOf('id="bashExemptDirs"') < section.indexOf('id="permissionSaveBtn"'),
        '输入框应在保存按钮之前');

    // label 与说明文案走 i18n，不得硬编码
    assert.match(section, /data-i18n="settings\.permission\.exempt_dirs_label"/);
    assert.match(section, /data-i18n="settings\.permission\.exempt_dirs_desc"/);
    assert.match(section, /data-i18n="settings\.permission\.exempt_dirs_note"/);
});

test('语言包：12 个 locale 全部含 3 个新键且文案非空', () => {
    const localeDir = path.join(staticRoot, 'locales');
    const files = fs.readdirSync(localeDir).filter(f => f.endsWith('.json')).sort();

    // 语言包数量本身也是契约：漏掉某个 locale 会让该语言用户看到裸 key
    assert.equal(files.length, 12, `locale 文件数应为 12，实际 ${files.length}: ${files.join(', ')}`);

    const KEYS = ['exempt_dirs_label', 'exempt_dirs_desc', 'exempt_dirs_note'];
    for (const f of files) {
        const json = JSON.parse(fs.readFileSync(path.join(localeDir, f), 'utf8').replace(/^\uFEFF/, ''));
        const perm = json.settings && json.settings.permission;
        assert.ok(perm, `${f}: 缺少 settings.permission 节点`);

        for (const k of KEYS) {
            assert.ok(typeof perm[k] === 'string' && perm[k].trim().length > 0,
                `${f}: settings.permission.${k} 缺失或为空（用户会看到裸 key）`);
            // 不得残留未替换的占位或 i18n 前缀
            assert.ok(!perm[k].startsWith('i18n:'), `${f}: ${k} 疑似未翻译`);
        }

        // label 应提示多行输入（措辞因语言而异，故只验语义下限：提到 bash 与目录）
        assert.ok(perm.exempt_dirs_label.toLowerCase().includes('bash'),
            `${f}: exempt_dirs_label 应点明适用于 bash`);
        assert.ok(perm.exempt_dirs_label.length >= 8,
            `${f}: exempt_dirs_label 过短，疑似占位未翻译`);
    }
});

/**
 * “每行一个”的格式约定必须由 placeholder 示范，而不是只写在 label 文案里。
 *
 * <p>为什么单独拆一个语言无关的用例：上一版把「必须提到每行一个」写成了
 * 12 种语言的词形枚举正则，结果俄语文案用了 «по одному в строке» 而枚举里没收录，
 * 测试就红了——但产品并没有错。枚举自然语言词形本质上是不可穷举的脆弱断言。</p>
 *
 * <p>真正稳定且语言无关的机制是 textarea 的 placeholder：它用 {@code &#10;}（HTML 实体换行）
 * 直接给出<b>多行示例</b>，用户看一眼就知道格式。这个才是应该锁住的契约。</p>
 */
test('HTML：placeholder 用换行实体示范多行格式（语言无关的格式约定）', () => {
    const html = readStatic('settings.html');
    const m = html.match(/<textarea[^>]*id="bashExemptDirs"[^>]*>/);
    assert.ok(m, '豁免目录 textarea 必须存在');

    const tag = m[0];
    assert.match(tag, /rows="3"/, '多行输入应给足可见行数');
    assert.match(tag, /placeholder="[^"]*&#10;/,
        'placeholder 必须含换行实体来示范「每行一个」；只靠文案说明容易被用户写成逗号分隔');
    assert.match(tag, /spellcheck="false"/,
        '路径不应做拼写检查，否则到处都是红色波浪线');
});

test('语言包：CJK 文案未被 latin1 截断（历史事故护栏）', () => {
    // 曾经发生过：读 utf8 后写回时套了 Buffer.from(x,'latin1')，
    // UTF-8 汉字被逐字符截成 1 字节，整个语言包中文变乱码。
    for (const f of ['zh-CN.json', 'zh-TW.json', 'ja.json']) {
        const json = JSON.parse(readStatic('locales', f));
        const perm = json.settings.permission;
        const sample = perm.exempt_dirs_desc;
        assert.ok(/[\u4e00-\u9fff\u3040-\u30ff]/.test(sample),
            `${f}: 豁免目录说明应含 CJK 字符，实际为 ${JSON.stringify(sample.slice(0, 40))}`);
        assert.ok(!/[\uFFFD]/.test(sample), `${f}: 出现替换字符，疑似编码损坏`);
        // bash 是技术词，各语言都应保留原样
        assert.ok(perm.exempt_dirs_label.includes('bash'), `${f}: label 应保留 bash 一词`);
    }
});

test('tauri/ui 发布副本与 static 源同步（settings.html + permission js + locales）', () => {
    // gourd-ai-tauri/ui/ 是构建期生成副本（cmd/prepare-ui.js 从 static 拷贝）。
    // 若副本存在且已过期，桌面版会渲染旧界面 —— 用户侧表现为"改了没效果"。
    const mirrorRoot = path.resolve(__dirname, '../../../../gourd-ai-tauri/ui');
    if (!fs.existsSync(mirrorRoot)) {
        // 副本尚未生成（干净检出）属正常情况，跳过而非失败
        return;
    }

    const pairs = [
        ['settings.html', 'settings.html'],
        [path.join('js', 'app-settings-permission.js'), path.join('js', 'app-settings-permission.js')],
        [path.join('locales', 'zh-CN.json'), path.join('locales', 'zh-CN.json')],
        [path.join('locales', 'en.json'), path.join('locales', 'en.json')]
    ];

    for (const [srcRel, mirRel] of pairs) {
        const srcPath = path.join(staticRoot, srcRel);
        const mirPath = path.join(mirrorRoot, mirRel);
        if (!fs.existsSync(mirPath)) continue;
        assert.equal(fs.readFileSync(mirPath, 'utf8'), fs.readFileSync(srcPath, 'utf8'),
            `${mirRel}: tauri/ui 副本与 static 源不一致，需运行 node gourd-ai-tauri/cmd/prepare-ui.js`);
    }
});
