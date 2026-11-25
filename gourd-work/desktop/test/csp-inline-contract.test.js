/* CSP × 内联样式契约锁：Tauri 的 hash 注入会静默废掉 'unsafe-inline'
 *
 * 【为什么需要这个测试 —— 真实缺陷复盘（2026-11-23 晚 → 11-24 用户连环报障）】
 * 2026-11-23 21:31 的安全加固把 tauri.conf.json 的 csp 从 null 改成严格策略，
 * 其中 style-src 写了 'unsafe-inline'，看起来内联样式仍被允许。但 Tauri
 * （tauri 2.x manager::set_csp → replace_csp_nonce）在伺服每个 HTML 资产时会
 * 把该资产里**静态内联 <script>/<style> 的 sha256 hash 追加进 CSP**。
 * 按 CSP3 规范：一旦 script-src/style-src 出现 hash/nonce 源，浏览器就
 * **忽略 'unsafe-inline'**（Chrome/WebView2 实测如此）。于是：
 *
 *   1. 运行时 createElement('style') 注入的样式全被拦——titlebar_ui.rs 的
 *      窗控按钮样式（#__gourd_window_controls__ 整段 CSS）与 ipc_bridge.rs 的
 *      拖拽区 user-select 规则都是运行时注入 → 窗控按钮裸奔（无尺寸/无 hover/
 *      无定位样式）＝用户截图「右上角窗控有问题」；
 *   2. innerHTML 写入的内联 style="" 属性全被拦——app-heatmap.js 的
 *      grid-template-columns（53 周列）与月份轴 left:% 定位 → 热力图塌成
 *      一列、月份标签堆叠＝「月份轴有问题」；app-turn-display.js 限高窗的
 *      transform/clip-path/margin-bottom 补偿（setStyle → style.setProperty）
 *      → 批次窗裁剪失效、正文叠压＝「消息区还是错乱」；
 *   3. chat.html/skills.html 等静态片段里 81 处 style="" 属性同样失效。
 *
 * 浏览器直连（Java static / 本地 http harness）没有 CSP 头，一切正常——
 * 这就是「浏览器里验证全绿、装进壳里就坏」且三轮修复都修不到点子的原因：
 * 前端代码本身没有错，是壳层 CSP 把它们的输出拦掉了。
 *
 * 【修复本体】dangerousDisableAssetCspModification: ["script-src","style-src"]
 * 禁止 Tauri 改写这两条指令 → 不再注入 hash → 'unsafe-inline' 按配置字面
 * 生效（内联样式恢复；内联脚本本就声明了 'unsafe-inline'，行为不变）。
 * 其余指令（object-src 'none'、base-uri、form-action 等）保持严格；
 * XSS 纵深防御由 app-ui.js 的 gourdSanitizeHtml 渲染出口白名单承担。
 *
 * 本测试锁死三件事，防回退：
 *   A. csp/devCsp 必须显式含 style-src 'unsafe-inline'（运行时注入样式的生存前提）；
 *   B. dangerousDisableAssetCspModification 必须同时覆盖 script-src 与 style-src
 *      （true 亦可）；漏掉任何一条，Tauri 就会重新注入 hash 废掉 unsafe-inline；
 *   C. 壳层确实存在运行时注入 <style> 的代码（titlebar_ui/ipc_bridge），
 *      证明 A/B 不是可有可无的装饰——若将来把这些样式迁进静态 CSS 文件，
 *      须连同本契约一起评审重写，而不是静默删锁。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TAURI_DIR = path.join(__dirname, '..', 'src-tauri');

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}
function readSrc(p) {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
}

/* 从 CSP 字符串里取某条指令的源列表 */
function directiveSources(csp, name) {
    const parts = String(csp).split(';').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const tokens = part.split(/\s+/);
        if (tokens[0] === name) return tokens.slice(1);
    }
    return null;
}

const conf = readJson(path.join(TAURI_DIR, 'tauri.conf.json'));
const security = conf.app && conf.app.security;

test('csp/devCsp 的 style-src 必须显式允许 unsafe-inline（运行时注入样式的生存前提）', () => {
    assert.ok(security && typeof security.csp === 'string' && security.csp.length > 0,
        'csp 不得为 null/空：安全加固必须保留严格 CSP（object-src/base-uri/form-action 等）');
    for (const key of ['csp', 'devCsp']) {
        const sources = directiveSources(security[key], 'style-src');
        assert.ok(sources, `${key} 缺少 style-src 指令`);
        assert.ok(sources.includes("'unsafe-inline'"),
            `${key} 的 style-src 缺少 'unsafe-inline'——titlebar_ui/ipc_bridge 运行时注入的 ` +
            '<style> 与 app-heatmap/app-turn-display 的内联 style 属性会全部被 CSP 拦截');
    }
});

test('dangerousDisableAssetCspModification 必须覆盖 script-src 与 style-src（禁止 Tauri 注入 hash）', () => {
    const v = security && security.dangerousDisableAssetCspModification;
    /* Tauri set_csp 会给每个 HTML 资产追加内联 <script>/<style> 的 sha256 hash；
       CSP3 规定 hash/nonce 出现时浏览器忽略 'unsafe-inline'——只写 unsafe-inline
       不禁注入，等于没写（2026-11-23 事故根因）。 */
    const covers = (dir) => v === true || (Array.isArray(v) && v.includes(dir));
    assert.ok(covers('script-src'),
        'dangerousDisableAssetCspModification 未覆盖 script-src：Tauri 将注入脚本 hash，' +
        "废掉 script-src 的 'unsafe-inline'（index.html 主题预置内联脚本会被拦）");
    assert.ok(covers('style-src'),
        'dangerousDisableAssetCspModification 未覆盖 style-src：Tauri 将注入样式 hash，' +
        "废掉 style-src 的 'unsafe-inline'（窗控样式/热力图 grid/批次窗补偿全灭）");
});

test('严格指令不因放行内联而丢失（object-src none / base-uri / form-action 仍在）', () => {
    for (const key of ['csp', 'devCsp']) {
        const csp = String(security[key]);
        assert.match(csp, /object-src\s+'none'/, `${key} 丢失 object-src 'none'`);
        assert.match(csp, /base-uri\s+'self'/, `${key} 丢失 base-uri 'self'`);
        assert.match(csp, /form-action\s+'none'/, `${key} 丢失 form-action 'none'`);
    }
});

test('壳层确实依赖运行时注入 <style>（本契约保护的真实消费方）', () => {
    for (const f of ['titlebar_ui.rs', 'ipc_bridge.rs']) {
        const src = readSrc(path.join(TAURI_DIR, 'src', f));
        assert.match(src, /createElement\('style'\)/,
            `${f} 不再运行时注入 <style>？若已迁静态 CSS，请连同本契约一起评审重写`);
    }
    /* 前端消费方抽查：热力图 grid 与批次窗补偿都是内联 style 写入 */
    const heatmap = readSrc(path.join(__dirname, '..', 'ui', 'js', 'app-heatmap.js'));
    assert.match(heatmap, /style="grid-template-columns:repeat\(/,
        'app-heatmap.js 的网格列数仍靠内联 style 属性写入（CSP 必须放行）');
    const turn = readSrc(path.join(__dirname, '..', 'ui', 'js', 'app-turn-display.js'));
    assert.match(turn, /setProperty\(|style\.transform|clipPath/,
        'app-turn-display.js 限高窗仍靠元素内联样式实现（CSP 必须放行）');
});
