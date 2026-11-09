/* Tauri 原生 drop handler 契约锁：HTML5 拖拽必须在 Rust 窗口 builder 上显式放行
 *
 * 【为什么需要这个测试 —— 真实缺陷复盘】
 * 2026-11 用户报障「侧栏任务/项目拖动排序：显示抓取小手，但根本拖不动」。
 * 排查发现前端 JS/CSS/DOM 全部正确，根因在 Rust 壳层：
 *
 *   Tauri（wry）默认在 WebView2 控件上注册一个 OLE drop target。因为 WebView2 是
 *   windowed control，这个原生 handler 会**吞掉整个 HTML5 拖拽事件族**——
 *   dragstart / dragover / drop 一个都不会派发到页面。二者互斥，官方文档原话：
 *   "Disabling it is required to use HTML5 drag and drop on the frontend on Windows."
 *   （tauri::webview::WebviewWindowBuilder::disable_drag_drop_handler 源码注释）
 *
 *   症状之所以极具欺骗性：cursor:grab 是纯 CSS，不经 JS，照常显示；手柄的
 *   mousedown 也能正常加 draggable 属性——但浏览器随后发起的 dragstart 被 wry
 *   吃掉，于是「手型对、属性对、就是拖不起来」。同一根因还静默废掉了模型设置页的
 *   供应商拖拽排序、以及 app-ui.js 里读 dataTransfer.files 的文件拖放上传。
 *
 * 【为什么 app-sidebar-order.test.js 的 23 个用例抓不到】
 * 那些用例用最小 DOM 桩 dispatch **合成** dragstart/dragover/drop，直接调 JS handler，
 * 完全绕过 WebView2 的原生拦截层。桩测试只能验证「事件到达后逻辑对不对」，
 * 永远验证不了「事件到底会不会到达」。这类壳层缺陷只能靠 Rust 源码静态锁 + 真机手测。
 *
 * 本测试锁死：窗口 builder 必须调用 .disable_drag_drop_handler()，且全项目不得
 * 依赖 Tauri 原生 DragDrop 事件（否则禁用它会破坏文件上传路径）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB_RS = path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs');

function readSrc(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
}

test('Rust 窗口 builder 必须调用 .disable_drag_drop_handler()（放行 HTML5 拖拽）', () => {
    const rs = fs.readFileSync(LIB_RS, 'utf8').replace(/^\uFEFF/, '');
    /* 这是本次缺陷的修复本体：漏掉它，所有 in-page 拖拽在 Windows 上静默失效 */
    assert.match(rs, /\.disable_drag_drop_handler\s*\(\s*\)/,
        'lib.rs 的 WebviewWindowBuilder 链上缺少 .disable_drag_drop_handler() —— ' +
        'wry 的 OLE drop target 会吞掉 dragstart/dragover/drop，前端拖拽全部失灵');
});

test('窗口只有一个构建点，且 disable_drag_drop_handler 就在该 builder 链上', () => {
    const rs = fs.readFileSync(LIB_RS, 'utf8').replace(/^\uFEFF/, '');
    /* 防止「加了调用但加错地方 / 被条件编译绕过」：断言它与 WebviewWindowBuilder::new
       在同一段链式调用里，且 .build() 之前。用位置序而非全文匹配，避免注释里的字面量误判。 */
    const newIdx = rs.indexOf('WebviewWindowBuilder::new');
    const disableIdx = rs.indexOf('.disable_drag_drop_handler');
    const buildIdx = rs.indexOf('builder.build()');
    assert.ok(newIdx >= 0, '找不到 WebviewWindowBuilder::new');
    assert.ok(disableIdx > newIdx, '.disable_drag_drop_handler 必须出现在 builder 构造之后');
    assert.ok(buildIdx > disableIdx, '.disable_drag_drop_handler 必须在 .build() 之前');
});

test('全项目不得依赖 Tauri 原生 DragDrop 事件（禁用后它们不再触发）', () => {
    /* 禁用原生 handler 的代价：WindowEvent::DragDrop（Rust）与 onDragDropEvent（JS）
       都不再派发。若将来有人要靠它拿文件的绝对路径，必须改用 DOM 的 dataTransfer.files
       （沙箱 File 对象）而非退回启用原生 handler —— 否则又会把 HTML5 拖拽打死。
       本断言是一道「别偷偷改回去」的护栏。 */
    const rs = readSrc('gourd-work/desktop/src-tauri/src/lib.rs');
    /* 允许注释里提及（解释性文字），但不得有真实的 match 分支消费它 */
    const nonComment = rs.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//') && !l.startsWith('///'))
        .join('\n');
    assert.doesNotMatch(nonComment, /WindowEvent::DragDrop/,
        'lib.rs 出现了消费 WindowEvent::DragDrop 的实际代码 —— 与 disable_drag_drop_handler 冲突');

    /* JS 侧同理：不得注册 onDragDropEvent 监听 */
    const uiDir = path.join(__dirname, '..', 'ui', 'js');
    for (const f of fs.readdirSync(uiDir)) {
        if (!f.endsWith('.js')) continue;
        const src = fs.readFileSync(path.join(uiDir, f), 'utf8');
        assert.doesNotMatch(src, /onDragDropEvent/,
            f + ' 注册了 Tauri onDragDropEvent —— 原生 handler 已禁用，该监听永不触发');
    }
});

test('前端拖拽功能确实依赖 HTML5 drag 事件族（契约前提自洽）', () => {
    /* 反证「禁用原生 handler 是必要的」：确认侧栏排序、供应商排序、文件上传
       都建立在 dragstart/dragover/drop 之上。若哪天它们全改成别的机制，
       本锁的前提就变了，应当重新评估。 */
    const order = readSrc('gourd-work/desktop/ui/js/app-sidebar-order.js');
    assert.match(order, /addEventListener\('dragstart'/);
    assert.match(order, /addEventListener\('dragover'/);
    assert.match(order, /addEventListener\('drop'/);

    const ui = readSrc('gourd-work/desktop/ui/js/app-ui.js');
    /* 文件上传读 dataTransfer.files —— 正是原生 handler 关闭后 DOM 层能拿到的东西 */
    assert.match(ui, /dataTransfer/, 'app-ui.js 的文件拖放依赖 dataTransfer');
});
