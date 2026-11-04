/* ===== model-settings-fetch-btn-state-contract.test.js =====
   「从 API 拉取模型」按钮的忙碌态契约。

   用户报障：「这个按钮拉取模型的时候转的时候显示有问题」。

   实测（Chromium/CDP 真机取证，改前）定位到 4 个缺陷：
   P0 永久卡死 —— fetchModels() 的按钮复原语句写在「表单是否被改动」守卫【之后】。
      请求在途时用户改了 API 地址 / 切了「模型列表接口」radio / 离开视图，success 直接
      return，按钮永久停在 spinner + disabled（实测 3 秒后仍在转，对按钮派发 click 不再
      触发任何 handler，只能刷整页恢复）。三条路径均已在浏览器里复现。
   P1 假 hover —— .provider-model-icon-btn:hover 没排除 :disabled。加载中按钮正是 disabled，
      而光标必然停在刚点过的按钮上，于是 border/color 被提亮成 --text-primary，
      再叠 opacity:.5，观感是「半透明但像被选中」。
   P2 平口弧线 —— spinner 内联 SVG 漏 stroke-linecap/linejoin（计算值 butt），
      与同按钮空闲态下载图标（round）不一致。
   P3 尺寸跳变 —— 空闲 16px、加载 14px，点击瞬间图标缩一圈。
   P4 置灰对比度 —— 复用 :disabled{opacity:.5} 把旋转图标相对底色的对比度
      从 16.2:1 压到 3.1:1（而用户此刻正盯着这枚按钮等结果）。

   为什么测试这么写：
   本仓前几轮反复栽在「断言某个词存在」的假绿灯上（词在、行为已废）。所以这里
   不锁措辞而锁【行为】：把 setFetchBtnBusy / fetchModels 真正切出来，用微型 DOM 桩
   真实执行，断言「守卫提前 return 之后按钮是否复原」这类可被单点变异杀死的行为；
   再用反向断言锁住不该出现的东西（散装复原、不设限的 :hover）。
*/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STATIC = path.resolve(__dirname, '../../main/resources/static');
// 仓库根：src/test/js → test → src → gourd-ai-agent → 仓库根（4 级）
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const TAURI_MODULE = path.join(REPO_ROOT, 'gourd-ai-tauri');
const MIRROR = path.join(TAURI_MODULE, 'ui');
const read = (...p) => fs.readFileSync(path.join(STATIC, ...p), 'utf8').replace(/^\uFEFF/, '');

const jsSource = read('js', 'app-model-settings.js');
const cssSource = read('css', 'settings.css');
const jsNorm = jsSource.split('\r\n').join('\n');
const cssNorm = cssSource.split('\r\n').join('\n');

/** 按函数名切出完整函数（花括号配平） */
function extractFunction(source, name) {
    const start = source.indexOf('function ' + name + '(');
    assert.ok(start >= 0, '未找到函数: ' + name);
    let i = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > start, '花括号不配平: ' + name);
    return source.slice(start, end + 1);
}

/** 从源码取出两个图标常量（保持单一事实来源，测试不复制一份内容） */
function iconsFromSource() {
    const icon = jsNorm.match(/var FETCH_BTN_ICON = '([\s\S]*?)';/);
    const spinner = jsNorm.match(/var FETCH_BTN_SPINNER = '([\s\S]*?)';/);
    assert.ok(icon, '未找到 FETCH_BTN_ICON 常量');
    assert.ok(spinner, '未找到 FETCH_BTN_SPINNER 常量');
    return { icon: icon[1], spinner: spinner[1] };
}

/* ============================================================
   行为 harness：用「真实源码 + 微型 DOM 桩」执行 fetchModels
   ------------------------------------------------------------
   jQuery 只用到 prop / toggleClass / html / val 四个方法。桩保持最小但保真：
     - prop('disabled', v) 必须真的记录，否则「永久卡死」无法辨别
     - html(s) 必须真的替换，否则 is-loading 的图标切换不可测
     - toggleClass 必须真的增删类
   所有时间点由测试掌控（$.ajax 只记录 config，回调由测试手动触发）。
   ============================================================ */
function createHarness(opts) {
    opts = opts || {};
    const cfg = {
        apiUrl: opts.apiUrl !== undefined ? opts.apiUrl : 'https://api.test/v1',
        standard: opts.standard || 'openai'
    };
    const { icon, spinner } = iconsFromSource();

    const btnEl = { disabled: false, innerHTML: icon, classes: new Set() };
    const pending = [];
    const toasts = [];

    const $btn = {
        prop(n, v) {
            if (n === 'disabled') { if (v === undefined) return btnEl.disabled; btnEl.disabled = !!v; }
            return this;
        },
        toggleClass(n, on) { if (on) btnEl.classes.add(n); else btnEl.classes.delete(n); return this; },
        html(v) { if (v === undefined) return btnEl.innerHTML; btnEl.innerHTML = String(v); return this; },
        val() { return ''; }
    };

    // 注意：函数体里的 fetchRequestId / fetchedModels 是模块级变量，
    // 由下面的 new Function 在闭包里声明，赋值只影响该闭包 —— 这正是被测代码的真实语义。
    const factory = new Function(
        '$', 'GourdI18n', 'showToast', 'showFetchFailure', 'loadLlmModelsCache',
        'renderModelsList', 'persistProvider', 'DEFAULT_STANDARD', 'escapeAttr',
        'selectedName', 'currentProvider',
        `var FETCH_BTN_ICON = ${JSON.stringify(icon)};
         var FETCH_BTN_SPINNER = ${JSON.stringify(spinner)};
         var fetchRequestId = 0;
         var fetchedModels = [];
         var escapeHtml = escapeAttr;
         ${extractFunction(jsNorm, 'setFetchBtnBusy')}
         ${extractFunction(jsNorm, 'fetchModels')}
         return { fetchModels: fetchModels, setFetchBtnBusy: setFetchBtnBusy };`
    );

    const $ = function (sel) {
        if (sel === '#msProviderFetchModelsBtn') return $btn;
        if (sel === '#msProviderApiUrl') return { val: () => cfg.apiUrl };
        if (sel === '#msProviderApiKey') return { val: () => '' };
        if (sel === 'input[name="msProviderStandard"]:checked') return { val: () => cfg.standard };
        throw new Error('未预期的选择器: ' + sel);
    };
    $.ajax = (c) => pending.push(c);

    const api = factory(
        $, { t: (k) => k }, (m, t) => toasts.push({ m, t }), () => { },
        (cb) => { if (cb) cb(); },          // loadLlmModelsCache：同步回调，等价于请求已回来
        () => { }, () => { }, 'openai', (s) => String(s),
        opts.selectedName || '__add__', opts.currentProvider || null
    );

    return {
        api,
        btn: btnEl,
        pending,
        toasts,
        cfg,
        /** 断言按钮已复原（三件事必须同时成立，避免只看其中一项被单点变异骗过） */
        assertIdle(msg) {
            assert.equal(btnEl.disabled, false, (msg || '') + '：按钮应可用');
            assert.equal(btnEl.classes.has('is-loading'), false, (msg || '') + '：应移除 is-loading');
            assert.doesNotMatch(btnEl.innerHTML, /animation:spin/, (msg || '') + '：不应还是旋转图标');
            assert.equal(btnEl.innerHTML, icon, (msg || '') + '：应回到空闲下载图标');
        },
        /** 断言按钮处于忙碌态 */
        assertBusy(msg) {
            assert.equal(btnEl.disabled, true, (msg || '') + '：按钮应禁用');
            assert.equal(btnEl.classes.has('is-loading'), true, (msg || '') + '：应有 is-loading');
            assert.match(btnEl.innerHTML, /animation:spin/, (msg || '') + '：应是旋转图标');
            assert.equal(btnEl.innerHTML, spinner, (msg || '') + '：应与 spinner 常量一致');
        }
    };
}

/* ===================== P0：请求落定后必须复原（核心回归） ===================== */

test('P0 表单在途被改动 → 请求落定后按钮必须复原', () => {
    const h = createHarness();
    h.api.fetchModels();
    h.assertBusy('发起后');
    assert.equal(h.pending.length, 1);

    // 用户请求期间改了 API 地址：success 里的表单一致性守卫将不成立
    h.cfg.apiUrl = 'https://api.changed/v2';
    h.pending[0].success({ code: 500, data: { reason: 'NETWORK_ERROR' } });

    h.assertIdle('【P0 回归】守卫不成立时也必须复原（改前会永久卡死）');
});

test('P0 表单在途切换「模型列表接口」→ 请求落定后按钮必须复原', () => {
    const h = createHarness();
    h.api.fetchModels();
    h.assertBusy('发起后');

    h.cfg.standard = 'anthropic';                        // 切了 radio
    h.pending[0].success({ code: 200, data: JSON.stringify({ data: [{ id: 'm1' }] }) });

    h.assertIdle('【P0 回归】切换接口类型后也必须复原');
});

test('P0 过期响应不得关掉最新请求的忙碌态', () => {
    const h = createHarness();
    h.api.fetchModels();       // #1
    h.api.fetchModels();       // #2（用户等不及重试）
    assert.equal(h.pending.length, 2);
    h.assertBusy('两次发起后');

    h.pending[0].success({ code: 500, data: { reason: 'NETWORK_ERROR' } });
    assert.equal(h.btn.disabled, true, '过期响应不得解除最新请求的忙碌态：disabled');
    assert.equal(h.btn.classes.has('is-loading'), true, '过期响应不得解除最新请求的忙碌态：is-loading');

    h.pending[1].success({ code: 500, data: { reason: 'NETWORK_ERROR' } });
    h.assertIdle('最新请求落定后');
});

test('P0 网络层失败（error 回调）也必须复原', () => {
    const h = createHarness();
    h.api.fetchModels();
    h.assertBusy('发起后');
    h.pending[0].error({ status: 0 });
    h.assertIdle('error 回调后');
});

test('P0 成功分支（含模型合并）同样要复原，且不得残留 is-loading', () => {
    const h = createHarness();
    h.api.fetchModels();
    h.pending[0].success({ code: 200, data: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) });
    h.assertIdle('成功分支后');
});

test('P0 缺少 API 地址时不应进入忙碌态，也不得把按钮锁死', () => {
    const h = createHarness({ apiUrl: '' });
    h.api.fetchModels();
    assert.equal(h.pending.length, 0, '地址为空不应发请求');
    h.assertIdle('早退分支');
});

function createCloseHarness() {
    const { icon, spinner } = iconsFromSource();
    const btnEl = { disabled: false, innerHTML: icon, classes: new Set() };

    // 宽容链式桩：除拉取按钮外的一切选择器/方法都是 no-op 且可链式
    const chain = () => {
        const o = {};
        ['removeClass', 'addClass', 'toggleClass', 'prop', 'html', 'text', 'hide', 'show',
            'toggle', 'attr', 'val', 'closest', 'on', 'find', 'is'].forEach(k => { o[k] = () => o; });
        return o;
    };
    const $btn = {
        prop(n, v) { if (n === 'disabled') { if (v === undefined) return btnEl.disabled; btnEl.disabled = !!v; } return $btn; },
        toggleClass(n, on) { if (on) btnEl.classes.add(n); else btnEl.classes.delete(n); return $btn; },
        html(v) { if (v === undefined) return btnEl.innerHTML; btnEl.innerHTML = String(v); return $btn; }
    };
    const $ = function (sel) {
        return sel === '#msProviderFetchModelsBtn' ? $btn : chain();
    };

    const factory = new Function(
        '$', 'GourdI18n', 'window', 'clearModelSearch',
        `var FETCH_BTN_ICON = ${JSON.stringify(icon)};
         var FETCH_BTN_SPINNER = ${JSON.stringify(spinner)};
         var currentProvider = null;
         var selectedName = '__add__';
         var fetchedModels = [];
         var modelSearchProviderKey = null;
         ${extractFunction(jsNorm, 'setFetchBtnBusy')}
         ${extractFunction(jsNorm, 'closeModelSettings')}
         return { closeModelSettings: closeModelSettings, setFetchBtnBusy: setFetchBtnBusy };`
    );

    const api = factory(
        $, { t: (k) => k },
        {},              // window：无 reloadModels，走不到通知分支（与本用例无关）
        () => { }        // clearModelSearch：无副作用即可
    );
    return { api, btnEl };
}

test('P0 请求在途时离开视图 → closeModelSettings 必须兜底复位（M10 回归）', () => {
    const h = createCloseHarness();
    // 先真的进入忙碌态（走真实 setFetchBtnBusy，不手改 DOM）
    h.api.setFetchBtnBusy(true);
    assert.equal(h.btnEl.disabled, true, '前置：应先进入忙碌态');
    assert.equal(h.btnEl.classes.has('is-loading'), true, '前置：应有 is-loading');
    assert.match(h.btnEl.innerHTML, /animation:spin/, '前置：应是旋转图标');

    // 视图被关闭：请求回调此时无人接收，必须由 closeModelSettings 收尾
    h.api.closeModelSettings();

    assert.equal(h.btnEl.disabled, false, '【M10 回归】关闭视图后按钮必须恢复可用');
    assert.equal(h.btnEl.classes.has('is-loading'), false, '【M10 回归】关闭视图后必须移除 is-loading');
    assert.doesNotMatch(h.btnEl.innerHTML, /animation:spin/, '【M10 回归】关闭视图后不得仍是旋转图标');
    assert.equal(h.btnEl.innerHTML, iconsFromSource().icon, '【M10 回归】应回到空闲下载图标');
});

test('closeModelSettings 的兜底复位必须无条件执行（不得置于早退分支之后）', () => {
    const body = extractFunction(jsNorm, 'closeModelSettings');
    // 定位兜底调用与所有 return —— 若 return 在调用之前，说明存在能绕过复位的早退路径
    const callAt = body.indexOf('setFetchBtnBusy(false)');
    assert.ok(callAt >= 0, 'closeModelSettings 必须调用 setFetchBtnBusy(false) 兜底');
    let retAt = -1;
    const re = /\breturn\b/g;
    let m;
    while ((m = re.exec(body))) {
        // 忽略注释中的 return（本仓已有“注释里含关键字”的误报先例）
        const lineStart = body.lastIndexOf('\n', m.index) + 1;
        const lineEnd = body.indexOf('\n', m.index);
        const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
        if (/(^|\s)\/\//.test(line)) continue;
        retAt = m.index;
        break;
    }
    assert.ok(retAt < 0 || callAt < retAt, '兜底复位不得排在 return 之后（否则早退路径会永久卡死按钮）');
});

test('按钮状态只允许经由唯一入口 setFetchBtnBusy 变更', () => {
    assert.match(jsNorm, /function setFetchBtnBusy\(busy\)/, '必须存在 setFetchBtnBusy');
    // 反向：除 setFetchBtnBusy 内部外，不得再有直接操作该按钮的散装写法
    const outside = jsNorm.replace(extractFunction(jsNorm, 'setFetchBtnBusy'), '');
    const direct = outside.match(/\$\('#msProviderFetchModelsBtn'\)[\s\S]{0,80}?\.(prop|html|toggleClass)\s*\(/g) || [];
    assert.deepEqual(direct, [], '不允许在 setFetchBtnBusy 之外直接操作拉取按钮，实际命中: ' + JSON.stringify(direct));
});

test('spinner 与空闲图标共用常量：16px + 圆头端点（P2/P3）', () => {
    const { icon, spinner } = iconsFromSource();
    assert.match(spinner, /^<svg width="16" height="16"/, 'P3：spinner 应为 16px（与空闲图标同尺寸）');
    assert.match(spinner, /stroke-linecap="round"/, 'P2：spinner 必须有 stroke-linecap="round"');
    assert.match(spinner, /stroke-linejoin="round"/, 'P2：spinner 必须有 stroke-linejoin="round"');
    assert.match(spinner, /animation:spin 1s linear infinite/, 'spinner 必须持续旋转');
    assert.doesNotMatch(jsNorm, /FETCH_BTN_SPINNER = '<svg width="14"/, 'P3：spinner 不应再是 14px');

    // 空闲图标存在【两份副本】：JS 常量（复原时写回）与 model-settings.html 里的初始模板。
    // 二者必须逐字节相同 —— 否则首次复原后图标会静默变样（例如 HTML 改了尺寸/addModel 新增属性
    // 而 JS 常量没跟）。这是「改一处忘另一处」的典型温床，又没有其它手段能发现。
    assert.equal(icon, idleIconFromHtml(),
        'FETCH_BTN_ICON 必须与 model-settings.html 中 #msProviderFetchModelsBtn 的初始 svg 逐字节一致');
});

/** 读取 model-settings.html 里拉取按钮的初始（空闲）图标，作为「另一份副本」的真相 */
function idleIconFromHtml() {
    const html = fs.readFileSync(
        path.join(STATIC, 'model-settings.html'), 'utf8').replace(/^\uFEFF/, '');
    const at = html.indexOf('id="msProviderFetchModelsBtn"');
    assert.ok(at >= 0, 'model-settings.html 中未找到 #msProviderFetchModelsBtn');
    const rest = html.slice(at);
    const m = rest.match(/<svg[\s\S]*?<\/svg>/);
    assert.ok(m, '拉取按钮内未找到初始 svg 图标');
    return m[0];
}

/* ===================== CSS 契约（P1 / P4） ===================== */

/** 提取选择器对应的规则体（取第一处） */
/** 取规则体：selector 可以是多选择器组里的任意一个 */
function ruleBody(css, selector) {
    const i = css.indexOf(selector);
    if (i < 0) return null;
    const start = css.indexOf('{', i);
    if (start < 0) return null;
    const end = css.indexOf('}', start);
    if (end < 0) return null;
    return css.slice(start + 1, end);
}

test('P1 hover 反馈必须排除 :disabled，且不设限的旧写法不得残留', () => {
    assert.ok(cssNorm.includes('.provider-model-icon-btn:hover:not(:disabled)'),
        'P1：icon 按钮 hover 规则必须排除 :disabled');
    assert.ok(cssNorm.includes('.provider-model-icon-btn.danger:hover:not(:disabled)'),
        'P1：danger 变体 hover 规则同样要排除 :disabled');
    // 反向：旧写法残留会让特异性回退，前置修复形同虚设
    assert.ok(!cssNorm.includes('.provider-model-icon-btn:hover {'),
        'P1：不设限的 .provider-model-icon-btn:hover 不得残留');
    assert.ok(!cssNorm.includes('.provider-model-icon-btn.danger:hover {'),
        'P1：不设限的 danger:hover 不得残留');
});

test('P4 忙碌态不置灰、改用强调色，且必须晚于 :disabled 才能覆盖', () => {
    const body = ruleBody(cssNorm, '.provider-model-icon-btn.is-loading');
    assert.ok(body, 'P4：必须存在 .provider-model-icon-btn.is-loading 规则');
    assert.match(body, /opacity:\s*1/, 'P4：忙碌态不得半透明');
    assert.match(body, /color:\s*var\(--accent\)/, 'P4：忙碌态应用强调色表达进行中');
    assert.match(body, /cursor:\s*progress/, 'P4：忙碌态光标应为 progress 而非 not-allowed');

    const idxDisabled = cssNorm.indexOf('.provider-model-icon-btn:disabled {');
    const idxLoading = cssNorm.indexOf('.provider-model-icon-btn.is-loading');
    assert.ok(idxDisabled > 0, '应存在 :disabled 规则');
    assert.ok(idxLoading > idxDisabled,
        'P4：is-loading 必须晚于 :disabled，否则同特异性下被 opacity:.5 覆盖');
});

test('is-loading 相关规则块内不得出现 opacity < 1', () => {
    const blocks = cssNorm.match(/\.provider-model-icon-btn\.is-loading[^{]*\{[^}]*\}/g) || [];
    assert.ok(blocks.length > 0, '应至少有一条 is-loading 规则');
    for (const b of blocks) {
        const m = b.match(/opacity:\s*([\d.]+)/);
        if (m) assert.equal(parseFloat(m[1]), 1, 'is-loading 内 opacity 必须为 1，实际: ' + m[1]);
    }
});

/* ===================== 发布副本同步（含假绿灯自证） ===================== */

test('tauri/ui 发布副本与 static 源字节一致（本批 2 个文件）', (t) => {
    // 两个陷阱，本仓都真实踩过：
    //  1) 镜像根路径少算一级（3 个 ../ 只到 gourd-ai-agent 根），配合
    //     `if (!existsSync) return` 变成「永远静默通过」的假绿灯（见 settings-disabled-contract）。
    //     对策：先自证【路径算术】—— 同一份基准算出的 repoRoot + 'gourd-ai-agent'
    //     必须与 staticRoot 同源。路径层数算错时这个断言必失败。
    //     （不用“同级模块必须存在”：稀疏检出时那是合法的不存在，会假红）
    //  2) ui/ 是 prepare-ui.js 生成的构建产物（已 gitignore），干净检出时本就不存在，
    //     用 node:test 的 skip 显式报告，不伪装成 PASS。
    assert.equal(
        path.join(REPO_ROOT, 'gourd-ai-agent'),
        path.resolve(STATIC, '../../../..'),
        `镜像路径算术错误：从 test/js 向上四级得 ${REPO_ROOT}，加 gourd-ai-agent 后与 STATIC 不同源`
    );

    if (!fs.existsSync(MIRROR)) {
        t.skip('镜像目录不存在（gourd-ai-tauri/ui 由 cmd/prepare-ui.js 生成且已 gitignore）');
        return;
    }

    for (const segs of [['js', 'app-model-settings.js'], ['css', 'settings.css']]) {
        const mirrorPath = path.join(MIRROR, ...segs);
        assert.ok(fs.existsSync(mirrorPath), '镜像文件缺失: ' + segs.join('/'));
        const source = fs.readFileSync(path.join(STATIC, ...segs));
        const mirror = fs.readFileSync(mirrorPath);
        assert.ok(source.equals(mirror),
            `gourd-ai-tauri/ui 副本与 static 源不同步（请执行 npm run prepare-ui）：${segs.join('/')}`);
    }
});
