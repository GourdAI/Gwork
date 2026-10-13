const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleRoot = path.resolve(__dirname, '../../..');
const staticRoot = path.join(moduleRoot, 'src/main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJava = (...parts) => fs.readFileSync(path.join(moduleRoot, 'src/main/java', ...parts), 'utf8').replace(/^\uFEFF/, '');
const readJavaTest = (...parts) => fs.readFileSync(path.join(moduleRoot, 'src/test/java', ...parts), 'utf8').replace(/^\uFEFF/, '');
const readRust = (...parts) => fs.readFileSync(path.join(moduleRoot, '..', 'gourd-ai-tauri/src-tauri/src', ...parts), 'utf8').replace(/^\uFEFF/, '');

/* 取顶层函数完整声明（含 function 头）：驱动执行必须用完整声明，body-only 会让
   函数从未声明（ReferenceError）——既有教训见 background-agent-card-visibility。 */
function fnFull(src, name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
    const m = src.match(re);
    assert.ok(m, name + ' 应存在于源码中');
    return m[0];
}

/* ===== 回归背景 =====
   工作空间路径含中文时「消息发送失败」：HTTP 头值只允许 ISO-8859-1 字符，前端把
   原始中文路径放进 X-Session-Cwd 头，Chromium 在 setRequestHeader / Headers 构造时
   直接抛 "String contains non ISO-8859-1 code point"，请求根本发不出去（jQuery 捕获
   后走 .fail → toast 报「消息发送失败」）。Playwright 实测：encodeURIComponent 后
   200 正常到达。修复 = 前端统一 encodeSessionCwdHeader 编码 + Java SessionCwdCodec /
   Rust percent_decode_component 读侧同步解码（component 语义：'+' 是字面量）。
   下列契约锁死三方口径与全部 12 个写点，防止回退成「一处漏编码就整链坏」。 */

/* 三端共享向量：与 Java SessionCwdCodecTest、Rust server.rs 测试同字面量互为对照 */
const CJK_PATH = 'D:\\工作\\项目A';
const CJK_ENCODED = 'D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA';

test('encodeSessionCwdHeader：component 编码，空值安全，共享向量对齐三端', () => {
    const base = readStatic('js', 'app-base.js');
    const encode = new Function(fnFull(base, 'encodeSessionCwdHeader') + '; return encodeSessionCwdHeader;')();
    // 共享向量：与 Java/Rust 测试里的字面量一致，任何一端语义漂移都会在对端暴露
    assert.equal(encode(CJK_PATH), CJK_ENCODED);
    assert.equal(encode('D:\\work\\proj'), 'D%3A%5Cwork%5Cproj'); // ':' 与 '\' 也被编码（无害：三端读侧都会还原）
    assert.equal(encode(null), '');
    assert.equal(encode(undefined), '');
    assert.equal(encode(''), '');
    // 全局导出：晚加载的业务脚本按 window.encodeSessionCwdHeader 取用
    assert.match(base, /window\.encodeSessionCwdHeader = encodeSessionCwdHeader;/);
});

test('写点收敛：全部 X-Session-Cwd 头值必须经 encodeSessionCwdHeader 编码', () => {
    const files = ['app-streaming.js', 'app-code.js', 'app-gitdiff.js', 'app-memory.js', 'app-todos.js', 'message-queue.js'];
    // 已知写点数：发送/附件上传/插话 ×3（streaming）、保存/监听 ×2（code）、git ×4、
    // memory ×1、todos ×1、队列 ×1。数目变化时必须同步更新本清单（新写点同样要编码）。
    const expectedSites = { 'app-streaming.js': 3, 'app-code.js': 2, 'app-gitdiff.js': 4, 'app-memory.js': 1, 'app-todos.js': 1, 'message-queue.js': 1 };
    let total = 0;
    for (const f of files) {
        const src = readStatic('js', f);
        let count = 0;
        src.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            // 两种写点形态：headers['X-Session-Cwd'] = v（引号在方括号内闭合）与
            // { 'X-Session-Cwd': v }（对象字面量）。值必须以 encodeSessionCwdHeader( 开头。
            const re = /(['"])X-Session-Cwd\1(?:\]\s*=|\s*:)\s*([^,;}\n]+)/g;
            let m;
            while ((m = re.exec(line)) !== null) {
                count++;
                assert.match(
                    m[2].trim(),
                    /^encodeSessionCwdHeader\(/,
                    f + ' 存在未经编码的 X-Session-Cwd 写点：' + line.trim()
                );
            }
        });
        assert.equal(count, expectedSites[f], f + ' 的写点数应为 ' + expectedSites[f] + '（若新增写点，须同步本清单并确认已编码）');
        total += count;
    }
    assert.equal(total, 12);
});

test('Java 读点收敛：WebController 全部 9 处头读取都经 SessionCwdCodec.decode', () => {
    const src = readJava('com', 'gourdai', 'core', 'portal', 'web', 'WebController.java');
    let count = 0;
    src.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        const re = /ctx\.header(?:OrDefault)?\(\s*(?:(["'])X-Session-Cwd\1[^)]*\)|AgentFlags\.X_SESSION_CWD\s*\))/g;
        let m;
        while ((m = re.exec(line)) !== null) {
            count++;
            assert.match(line, /SessionCwdCodec\.decode\(/, '未解码的头读取：' + line.trim());
        }
    });
    assert.equal(count, 9, 'WebController 头读取点数应为 9（新增读取点同样要经 SessionCwdCodec.decode）');
});

test('Java 解码器语义：component 口径 + '+' 字面量 + 残缺序列回退（源码级断言）', () => {
    // 断言目标：生产类（解码实现）+ 测试类（共享向量互验）。共享向量必须出现在
    // Java 测试里才能与 JS/Rust 两端互为对照；生产类里不需要它。
    const src = readJava('com', 'gourdai', 'core', 'portal', 'web', 'SessionCwdCodec.java');
    const testSrc = readJavaTest('com', 'gourdai', 'core', 'portal', 'web', 'SessionCwdCodecTest.java');
    // '+' 先转义 %2B 再进 URLDecoder：这是与表单语义区分的关键一行，删掉即回退成
    // 「+ → 空格」，路径 D:\C++proj 会被静默破坏
    assert.match(src, /replace\("\+", "%2B"\)/);
    // 共享向量进测试（与 JS 侧互为对照）
    assert.match(testSrc, /D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA/);
    // 快速路径：纯 ASCII 不含 '%'/'+' 原样返回（旧客户端兼容）
    assert.match(src, /indexOf\('%'\) < 0 && raw\.indexOf\('\+'\) < 0/);
});

test('Rust 读点收敛：proxy_http 的头读取经 percent_decode_component（component 语义）', () => {
    const src = readRust('server.rs');
    // 头读取处必须接 component 解码（不能是 urlpercent_decode：那是表单语义，'+' 会变空格）。
    // 窗口 1200：读头与 .map 之间有一段修复说明注释，窗内须包含解码链。
    assert.match(src, /\.get\("x-session-cwd"\)[\s\S]{0,1200}?\.map\(percent_decode_component\)/);
    assert.match(src, /fn percent_decode_component\(s: &str\) -> String/);
    // 共享向量同样出现在 Rust 测试里（三方互验）
    assert.match(src, /D%3A%5C%E5%B7%A5%E4%BD%9C%5C%E9%A1%B9%E7%9B%AEA/);
    // WS/query 通道维持表单语义不动（既有约定）：两者并存恰恰证明语义是有意区分的
    assert.match(src, /fn urlpercent_decode\(s: &str\) -> String/);
});

test('WS 通道本来就安全：gate 与 terminal 的 cwd 均走 encodeURIComponent query 参数', () => {
    const streaming = readStatic('js', 'app-streaming.js');
    assert.match(streaming, /\?cwd=' \+ encodeURIComponent\(gateCwd\)/);
    const terminal = readStatic('js', 'app-terminal.js');
    assert.match(terminal, /\?cwd=' \+ encodeURIComponent\(root\)/);
});
