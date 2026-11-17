/* CREATE_NO_WINDOW 契约：内核里每一个子进程 spawn 都必须抑制控制台窗口
 *
 * 【缺陷机制 —— 2026-11「连接器页无限弹命令窗」的真实根因】
 * GWork 桌面端是 GUI 宿主：进程本身没有 console。Windows 对「无 console 的父进程
 * spawn 一个控制台子系统程序（node.exe / where.exe / npm / git …）」的默认行为是
 * **给子进程新建一个控制台窗口**。于是每 spawn 一次就闪一个黑框。
 *
 * 当年的病灶在 `core/src/runtime/node.rs`：探测系统 Node 的 `where.exe node` 与
 * 探测版本的 `node --version` 两处 spawn **漏配** `creation_flags(CREATE_NO_WINDOW)`
 * （同文件其它 spawn、以及 mcp/cli.rs、mcp/mod.rs、terminal.rs、gitops.rs 都配了）。
 * 连接器页对每条 CLI 连接器都要跑一次 `locate()` → `detect_managed()`（1 次
 * `node --version`）+ `detect_system_node()`（1 次 `where.exe` + N 次
 * `node --version`），前端轮询/重渲染时反复触发 → 用户看到「无限弹命令窗」。
 *
 * 这类缺陷的危险之处在于它是**逐调用点纪律**：漏一处就闪窗，而且 mock 单测完全
 * 测不出来（测试环境有 console，根本不弹窗）。本测试把纪律升级成**全仓源码扫描**：
 * 任何新增的裸 spawn 都会在这里红灯，而不是等到用户报障。
 *
 * 【规则】
 * `core/src` 下每个 .rs 文件的生产代码里，每一处 `Command::new(` 都必须在其后紧邻的
 * 构造链里出现下列之一：
 *   - `creation_flags(` （直接配 flag）
 *   - `no_window(`      （调本模块/共享 helper）
 * 测试代码（`#[cfg(test)]` 模块内）豁免：测试跑在有 console 的环境，且常用
 * `assert_cmd` 之类构造命令对象而不真正 spawn。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const CORE_SRC = path.join(ROOT, 'gourd-work', 'core', 'src');

/** 递归收集 .rs 文件（跳过 target/ 之类不该存在的东西）。 */
function walkRs(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'target' || e.name === 'fixtures') continue;
            walkRs(p, out);
        } else if (e.name.endsWith('.rs')) {
            out.push(p);
        }
    }
    return out;
}

/**
 * 剥掉只在非 Windows 编译/运行的 `#[cfg(...)] mod/fn/块`，返回 Windows 视角的源码。
 *
 * 为什么要剥：Unix 没有「控制台窗口」这个概念，`#[cfg(unix)]` 块里的裸 spawn
 * 在 Windows 上根本不存在（连编译都不参与），要求它配 CREATE_NO_WINDOW 既无意义
 * 也做不到（tokio/std 的 `creation_flags` 在非 Windows target 上不存在，
 * 配了反而 E0599 编译失败）。
 */
function stripNonWindowsCfg(src) {
    const NON_WIN = /#\[cfg\(\s*(?:unix|target_os\s*=\s*"(?:linux|macos)"|not\(windows\))\s*\)\]/g;
    let out = '';
    let i = 0;
    let m;
    NON_WIN.lastIndex = 0;
    while ((m = NON_WIN.exec(src)) !== null) {
        out += src.slice(i, m.index);
        // 属性之后跟的是 `{...}` 裸块、`fn name(...) {...}` 或 `mod name {...}`。
        // 统一策略：从属性末尾往后找第一个 `{`，做花括号配对，整段切掉。
        const braceOpen = src.indexOf('{', m.index + m[0].length);
        if (braceOpen < 0) {
            out += src.slice(m.index);
            i = src.length;
            break;
        }
        let depth = 0;
        let j = braceOpen;
        for (; j < src.length; j++) {
            const c = src[j];
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) { j++; break; }
            }
        }
        i = j;
        NON_WIN.lastIndex = j;
    }
    out += src.slice(i);
    return out;
}

/**
 * 剥掉 `#[cfg(test)] mod xxx { ... }` 块，返回「生产代码」文本。
 *
 * 为什么要剥：本仓约定测试模块写在文件尾部（registry.rs / cli.rs / node.rs 都如此），
 * 但不能依赖「截断到第一个 #[cfg(test)]」——那样会连带吞掉其后的生产代码。
 * 这里做真正的花括号配对，逐块精确切除。
 */
function stripTestModules(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const at = src.indexOf('#[cfg(test)]', i);
        if (at < 0) {
            out += src.slice(i);
            break;
        }
        out += src.slice(i, at);
        // 从属性之后找到 `mod NAME {`，再配对到该 mod 的收尾花括号。
        const modKw = src.indexOf('mod ', at);
        if (modKw < 0) {
            out += src.slice(at);
            break;
        }
        const braceOpen = src.indexOf('{', modKw);
        if (braceOpen < 0) {
            out += src.slice(at);
            break;
        }
        let depth = 0;
        let j = braceOpen;
        for (; j < src.length; j++) {
            const c = src[j];
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) { j++; break; }
            }
        }
        i = j; // 跳过整个测试 mod
    }
    return out;
}

/** 生产视角源码 = 去掉测试模块 + 去掉非 Windows cfg 块。 */
function windowsProdView(raw) {
    return stripNonWindowsCfg(stripTestModules(raw));
}

const BACK = 400;   // 向后看：覆盖 `if cfg!(windows) { …flag… } else { Command::new("sh") }`
const FORWARD = 900; // 向前看：覆盖 `let mut c = Command::new(x); c.args(…); no_window(&mut c);`

const FLAGGED = /creation_flags\s*\(|no_window\s*\(/;

/**
 * 扫描生产代码里的裸 spawn。返回 [{file, line, snippet}]。
 *
 * 判定窗口为什么是「前 900 + 后 400」双向：
 * * 向前 900 —— 本仓主流写法是先建 Command 再补 flag
 *   （`cmd.arg(..); no_window(&mut cmd);` 或 `#[cfg(windows)] { c.creation_flags(..) }`）。
 * * 向后 400 —— `if cfg!(windows) { …powershell + flag… } else { Command::new("sh") }`
 *   这种**运行时** if（不是 cfg 属性，无法靠 stripNonWindowsCfg 切除）里，
 *   else 臂的 spawn 在 Windows 上永不执行，且 flag 出现在它**前面**的 if 臂里。
 *   单向窗口会把这类合法代码误报成违规。
 */
function findBareSpawns(prodSrc, relFile) {
    const offenders = [];
    const re = /Command::new\(/g;
    let m;
    while ((m = re.exec(prodSrc)) !== null) {
        const from = Math.max(0, m.index - BACK);
        const around = prodSrc.slice(from, m.index + FORWARD);
        if (FLAGGED.test(around)) continue;
        const line = prodSrc.slice(0, m.index).split('\n').length;
        offenders.push({
            file: relFile,
            line,
            snippet: prodSrc.slice(m.index, m.index + 200).split('\n').slice(0, 4).join(' | '),
        });
    }
    return offenders;
}

/* ── 探测器自检 ────────────────────────────────────────────────────────────────
 * 全仓扫描类测试最大的风险是**假绿灯**：扫描器失效（路径错、正则漏、strip 过度）
 * 时它会安静地报「零违规」。所以先用合成样本证明探测器「该抓的抓得到、
 * 该放的放得过」，再去扫真实代码。这几条样本全部取自本仓真实形态。 */
test('探测器自检：能抓住裸 spawn，也不误报合法形态', () => {
    // ① 真病灶（node.rs 2026-11 原样）：整个文件没有任何 flag → 必须抓到 2 处
    const diseased = `
pub fn detect_system_node() -> Option<(PathBuf, String)> {
    if let Ok(out) = std::process::Command::new(which).arg("node").output() {
        println!("{}", out.status);
    }
    None
}
fn probe_version(path: &Path) -> Option<String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    Some(String::new())
}
`;
    const caught = findBareSpawns(stripTestModules(diseased), 'synthetic/diseased.rs');
    assert.strictEqual(caught.length, 2,
        '探测器失效：node.rs 的真实病灶形态（2 处裸 spawn）必须被抓到，实抓 ' + caught.length);

    // ② 修复后形态：调 no_window helper → 零违规
    const fixedHelper = `
fn probe_version(path: &Path) -> Option<String> {
    let mut cmd = Command::new(path);
    cmd.arg("--version").stdin(Stdio::null());
    no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    Some(String::new())
}
`;
    assert.deepStrictEqual(findBareSpawns(stripTestModules(fixedHelper), 'synthetic/a.rs'), [],
        'no_window(&mut cmd) 形态必须放行');

    // ③ 直接配 flag → 零违规
    const fixedFlag = `
fn run(node: &Path) {
    let mut cmd = Command::new(node);
    cmd.arg("install");
    #[cfg(windows)]
    { cmd.creation_flags(0x0800_0000); }
    let _ = cmd.output();
}
`;
    assert.deepStrictEqual(findBareSpawns(stripTestModules(fixedFlag), 'synthetic/b.rs'), [],
        'creation_flags 形态必须放行');

    // ④ 运行时 if cfg!(windows) 的 else 臂（terminal.rs 形态）→ 零违规
    const runtimeIf = `
pub async fn spawn(&self) {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-NoLogo"]);
        #[cfg(windows)]
        { c.creation_flags(CREATE_NO_WINDOW); }
        c
    } else {
        Command::new("sh")
    };
    let _ = cmd.spawn();
}
`;
    assert.deepStrictEqual(
        findBareSpawns(windowsProdView(runtimeIf), 'synthetic/c.rs'), [],
        'if cfg!(windows) 的 else 臂在 Windows 上永不执行，不得误报');

    // ⑤ #[cfg(unix)] 块内的裸 spawn（builtin/mod.rs 形态）→ 零违规
    const unixBlock = `
pub async fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("taskkill");
        c.args(["/T", "/F"]);
        { c.creation_flags(0x0800_0000); }
        let _ = c.output();
    }
    #[cfg(unix)]
    {
        let mut c = std::process::Command::new("kill");
        c.args(["-KILL", "-1"]);
        let _ = c.output();
    }
}
`;
    assert.deepStrictEqual(
        findBareSpawns(windowsProdView(unixBlock), 'synthetic/d.rs'), [],
        '#[cfg(unix)] 块在 Windows 上不编译，不得误报');

    // ⑥ #[cfg(test)] 模块内的裸 spawn → 零违规（测试环境有 console）
    const testMod = `
pub fn prod() {
    let mut c = Command::new("git");
    no_window(&mut c);
    let _ = c.output();
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn t() {
        let c = Command::new("cargo");
        let _ = c.output();
    }
}
`;
    assert.deepStrictEqual(
        findBareSpawns(windowsProdView(testMod), 'synthetic/e.rs'), [],
        '#[cfg(test)] 模块内的 spawn 必须豁免');

    // ⑦ 反向保险：strip 不能过度——测试模块**之后**的生产裸 spawn 仍须抓到
    const afterTest = `
#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert!(true); }
}
pub fn late_prod() {
    let c = Command::new("curl");
    let _ = c.output();
}
`;
    assert.strictEqual(
        findBareSpawns(windowsProdView(afterTest), 'synthetic/f.rs').length, 1,
        'stripTestModules 过度切除：测试模块之后的生产裸 spawn 漏检');
});

test('内核所有子进程 spawn 都必须抑制控制台窗口（CREATE_NO_WINDOW）', () => {
    assert.ok(fs.existsSync(CORE_SRC), 'core/src 不存在，路径契约变了：' + CORE_SRC);
    const files = walkRs(CORE_SRC);
    assert.ok(files.length > 20, '扫到的 .rs 文件数异常偏少（' + files.length + '），扫描器可能失效');

    let totalSpawns = 0;
    const offenders = [];
    const filesWithSpawns = [];
    for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
        const prod = stripTestModules(raw);
        const n = (prod.match(/Command::new\(/g) || []).length;
        if (n > 0) filesWithSpawns.push(rel);
        totalSpawns += n;
        offenders.push(...findBareSpawns(prod, rel));
    }

    // 扫描器自检：必须真的扫到已知 spawn 点，否则「零违规」是假绿灯。
    // 这几个文件是 2026-11 审计确认的生产 spawn 宿主，消失即说明扫描器/目录结构变了。
    for (const expect of ['gourd-work/core/src/terminal.rs', 'gourd-work/core/src/gitops.rs']) {
        assert.ok(filesWithSpawns.includes(expect),
            '扫描器自检失败：' + expect + ' 应含生产 spawn，但没被扫到。' +
            ' 文件被删/改名请同步本契约，别让「零违规」变成假绿灯。');
    }
    assert.ok(totalSpawns >= 5,
        '生产 spawn 总数 ' + totalSpawns + ' 异常偏少，扫描器可能失效（假绿灯风险）');

    assert.deepStrictEqual(offenders, [],
        '\n发现裸 spawn（Windows 上会闪控制台窗口，GUI 宿主下表现为「无限弹命令窗」）：\n' +
        offenders.map(o => '  - ' + o.file + ':' + o.line + '\n      ' + o.snippet).join('\n') +
        '\n修法：给 Command 配 creation_flags(0x0800_0000)，或调用本模块的 no_window(&mut cmd) helper。\n' +
        '非 Windows 分支（sh/kill 等）也要配——用 #[cfg(windows)] 包住 creation_flags，\n' +
        '或提供 #[cfg(not(windows))] fn no_window(_: &mut Command) {} 空实现。\n');
});

test('抑制窗口的 flag 值必须是 CREATE_NO_WINDOW（0x08000000），不得写错成别的 flag', () => {
    const files = walkRs(CORE_SRC);
    const bad = [];
    for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
        // 允许的字面形态：creation_flags(0x0800_0000) / creation_flags(CREATE_NO_WINDOW)
        const re = /creation_flags\s*\(\s*([^)]*?)\s*\)/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
            const arg = m[1].trim();
            const ok = /^0x0800_0000$/i.test(arg)
                || /^0x08000000$/i.test(arg)
                || /^CREATE_NO_WINDOW$/.test(arg);
            if (!ok) {
                const line = raw.slice(0, m.index).split('\n').length;
                bad.push(rel + ':' + line + ' → creation_flags(' + arg + ')');
            }
        }
    }
    assert.deepStrictEqual(bad, [],
        '发现可疑的 creation_flags 实参（不是 CREATE_NO_WINDOW）：\n  ' + bad.join('\n  ') +
        '\n  注：0x08000000 = CREATE_NO_WINDOW。若确实要用别的 flag（如 DETACHED_PROCESS），' +
        ' 必须同时保证不产生控制台窗口，并在本测试里加白名单说明理由。');
});
