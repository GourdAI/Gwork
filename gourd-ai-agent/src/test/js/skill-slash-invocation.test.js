const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.resolve(__dirname, '../../main/resources/static');
const readStatic = (...parts) => fs.readFileSync(path.join(staticRoot, ...parts), 'utf8').replace(/^\uFEFF/, '');

/* 技能调用入口收敛到 "/"、并下线「快捷命令」的契约。
 *
 * 背景：技能原先独占 "$" 符号，由前端把符号塞进输入框，后端零解析——
 * 符号连名字原样发给模型，能不能用上全看模型自觉；而 "$" 对中文用户
 * 要切键盘、视觉上又和 "/" 抢注意力。现在统一为 "/"（只列技能），
 * "$" 彻底移除，「快捷命令」菜单项下线（命令仍可手写，不再占面板）。
 * 这组断言守住「不会被悄悄改回去」的几条硬约束。 */

test('/ 补全面板只列技能，不再混命令也不再认 $', () => {
    const history = readStatic('js', 'app-history.js');

    // 触发符 → 候选类型的映射：'/' 必须是 skill，不能是 command
    assert.match(history, /var filterType = \(trigger === '@'\) \? 'subagent' : 'skill';/,
        "/ 必须映射到 skill（旧实现是 command），否则面板又会列出命令");
    assert.doesNotMatch(history, /trigger === '\$'/,
        "$ 触发分支必须消失，否则技能仍有两个符号");

    // 输入侧触发条件：只认 / 和 @
    assert.doesNotMatch(history, /val\.indexOf\('\$'\) === 0/,
        "输入框不得再因 $ 开头弹出补全");

    // 选词回填时找前缀：不得再把 $ 当前缀
    assert.doesNotMatch(history, /ch === '\$'/,
        "applyCmdSelection 的前缀扫描不得再认 $");
});

test('$ 技能按钮接线已移除，技能走 /', () => {
    const history = readStatic('js', 'app-history.js');
    const html = readStatic('chat.html');

    // 按钮接线：技能按钮必须插 '/'
    assert.match(history, /\$\('#welcomeSkillBtn'\)\.on\('click', function\(\) \{\s*triggerCmdComplete\(welcomeInput, \$welcomeCmdComplete\[0\], '\/'\);/,
        "欢迎页技能按钮必须插入 /");
    assert.match(history, /\$\('#chatSkillBtn'\)\.on\('click', function\(\) \{\s*triggerCmdComplete\(chatInput, \$chatCmdComplete\[0\], '\/'\);/,
        "对话页技能按钮必须插入 /");
    assert.doesNotMatch(history, /triggerCmdComplete\([^)]*'\$'\)/,
        "任何按钮都不得再插入 $ 前缀");

    // 技能图标：字形从 $ 改为 /（它是唯一的技能入口符号）
    const skillIconSlash = /<text[^>]*>\/<\/text>/g;
    assert.equal((html.match(skillIconSlash) || []).length, 2,
        "chat.html 两处技能按钮（欢迎页 + 对话页）图标都应为 /");

    // DOM 里不再有 $ 字形
    assert.doesNotMatch(html, /<text[^>]*>\$<\/text>/, "chat.html 不得残留 $ 字形图标");
});

test('「快捷命令」菜单项已下线（三处宿主）', () => {
    const html = readStatic('chat.html');
    const automation = readStatic('js', 'app-automation.js');

    assert.doesNotMatch(html, /id="welcomeCmdBtn"/, "欢迎页快捷命令菜单项应删除");
    assert.doesNotMatch(html, /id="chatCmdBtn"/, "对话页快捷命令菜单项应删除");
    assert.doesNotMatch(automation, /id="autoCmdBtn"/, "自动化页快捷命令菜单项应删除");

    // 但「技能」入口必须都还在，否则等于把技能藏了
    assert.match(html, /id="welcomeSkillBtn"/);
    assert.match(html, /id="chatSkillBtn"/);
    assert.match(automation, /id="autoSkillBtn"/);

    // 无动作的死接线不能留
    assert.doesNotMatch(automation, /'#autoCmdBtn'/, "自动化页不得再绑 autoCmdBtn");
    assert.doesNotMatch(html, /cmd_commands/, "chat.html 不得再引用已删除的 i18n 键");
    assert.doesNotMatch(automation, /app\.cmd_commands/, "自动化页不得再引用已删除的 i18n 键");
});

test('cmd_commands 键已从全部语言包移除（键集合必须一致）', () => {
    const localesDir = path.join(staticRoot, 'locales');
    const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 10, '语言包数量异常（' + files.length + '），疑似路径错了');

    for (const f of files) {
        const raw = fs.readFileSync(path.join(localesDir, f), 'utf8').replace(/^\uFEFF/, '');
        assert.ok(!raw.includes('"cmd_commands"'),
            f + ' 仍含 cmd_commands：删了入口却留键，键集合会与其他语言漂移');
    }
});

test('补全面板候选项仍带 skill 语义类名与描述（改符号不能丢视觉分层）', () => {
    const history = readStatic('js', 'app-history.js');
    const css = readStatic('css', 'app.css');

    assert.match(history, /var nameClass = \(trigger === '@'\) \? 'cmd-name subagent' : 'cmd-name skill';/,
        "候选名必须继续带 skill 类，否则与子代理失去颜色区分");
    assert.match(css, /\.cmd-complete-item \.cmd-name\.skill \{[^}]*color:/,
        "skill 候选的专属颜色样式不能丢");
    assert.match(history, /escapeHtml\(cmd\.description \|\| ''\)/,
        "候选描述必须继续转义（技能描述是用户数据，未转义会注入 DOM）");
});

test('CLI 侧：技能并入 / 补全，$ 补全移除，欢迎提示同步', () => {
    const completer = fs.readFileSync(
        path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/cli/CliCompleter.java'),
        'utf8'
    );
    const shell = fs.readFileSync(
        path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/cli/CliShell.java'),
        'utf8'
    );

    assert.doesNotMatch(completer, /startsWith\("\$"\)/,
        'CLI 不得再有 $ 触发分支');
    assert.match(completer, /SkillDir skill : engine\.getSkills\(\)/,
        '技能必须仍在 / 分支里参与补全（否则 CLI 侧等于删掉了技能发现）');
    assert.match(completer, /Candidate\("\/" \+ skill\.getName\(\)/,
        '技能候选必须以 / 前缀展示');

    // 欢迎提示：不能再宣传 $ 技能入口
    assert.doesNotMatch(shell, /"\$\(tab\)"/, 'CLI 欢迎提示不得再宣传 $(tab) skill');
    assert.match(shell, /"\/\(tab\)"[^;]*command\/skill/,
        'CLI 欢迎提示应把 / 标为 command/skill 统一入口');
});

test('服务端三入口都在「命令未命中」后落到技能解析（同名技能不得改写内建命令）', () => {
    const read = (p) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

    const webGate = read('main/java/com/gourdai/core/portal/web/WebGate.java');
    const wsGate = read('main/java/com/gourdai/core/portal/desktop/WsGate.java');
    const cliShell = read('main/java/com/gourdai/core/portal/cli/CliShell.java');

    for (const [name, src] of [['WebGate', webGate], ['WsGate', wsGate], ['CliShell', cliShell]]) {
        assert.match(src, /getCommandRegistry\(\)\.find\(/,
            name + ' 必须先查命令注册表（内建命令优先）');
        assert.match(src, /SkillInvocation\.parse\(engine\.getSkills\(\)/,
            name + ' 必须在命令未命中时解析技能，否则 /技能名 仍然不生效');
    }

    // 解析器本身必须注入 SKILL.md 正文，而不是只把名字传给模型
    const invocation = read('main/java/com/gourdai/harness/talents/cli/SkillInvocation.java');
    assert.match(invocation, /provider\.readSkill\(matched\.getName\(\)\)/,
        '必须真正读取技能内容；只解析名字等于回到「让模型自己领会」的老路');
    assert.match(invocation, /public static final String TRIGGER = "\/";/,
        '触发符必须是 /');
});

test('斜杠技能调用的用户消息必须落盘（不能被当成命令跳过历史回放）', () => {
    const webGate = fs.readFileSync(
        path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web/WebGate.java'),
        'utf8'
    );

    /* 回归：user 帧落盘条件曾是 !input.startsWith("/")。技能改用 / 后，
       /技能名 也命中这条排除规则 → 用户消息不进历史回放（刷新页面后自己说过什么全没了），
       而首次发送看不出任何异常。改为按「是否真能路由为内建命令」判定。 */
    assert.match(webGate, /!isRegistryCommand\(input\) && streamStore != null/,
        '落盘条件必须按注册命令判定，不能按 / 前缀一刀切');
    assert.doesNotMatch(webGate, /!input\.startsWith\("\/"\) && streamStore != null/,
        '旧的 / 前缀排除逻辑必须删除');

    // 判定函数本身：必须是查注册表，且与 isCommand 同口径
    assert.match(webGate, /private boolean isRegistryCommand\(String input\)/,
        'isRegistryCommand 必须存在');
    assert.match(webGate,
        /private boolean isRegistryCommand[\s\S]{0,600}engine\.getCommandRegistry\(\)\.find\(parts\.get\(0\)\.toLowerCase\(\)\) != null/,
        'isRegistryCommand 必须按命令名查注册表，否则判定口径与真路由不一致');
});

/* ===== 以下两条为 2026-10-21 code review 查出的真实缺陷回归 ===== */

test('两级技能名点选补全不得拼出重复前缀（/design/design/lanhu）', () => {
    const history = readStatic('js', 'app-history.js');

    /* 缺陷原貌：applyCmdSelection 从尾部向前反向扫描 / 或 @，取第一个命中位当触发符。
       技能名本身可含 /（TalentRegistry 保留相对路径作名字，如 design/lanhu），
       于是最后一个 / 落在名字内部，回填变成 /design/design/lanhu。
       该值到服务端已非合法技能名 → 静默降级为普通文本、SKILL.md 完全不注入。
       旧符号 $ 不会踩（$ 不在技能名里），所以这是改用 / 之后新引入的回归。 */

    const fn = history.match(/function applyCmdSelection[\s\S]*?\n\}/);
    assert.ok(fn, 'applyCmdSelection 必须存在');
    const body = fn[0];

    // 必须校验触发符处于「行首或空白之后」，不能见 / 就认
    assert.match(body, /i === 0 \|\| \/\\s\/\.test\(val\.charAt\(i - 1\)\)/,
        '触发符必须限定在行首或空白之后，否则两级技能名会被重复拼接');

    // 反向对照：不允许退回「直接赋值 prefixPos 就 break」的无条件写法
    assert.doesNotMatch(body, /if \(ch === '\/' \|\| ch === '@'\) \{\s*prefixPos = i;\s*break;/,
        '不得回退为无条件命中任意 / 或 @（那会让 /design/lanhu 回填成 /design/design/lanhu）');
});

test('WebGate.isCommand 对空参数必须有守卫（纯 / 不得抛越界）', () => {
    const webGate = fs.readFileSync(
        path.resolve(__dirname, '../../main/java/com/gourdai/core/portal/web/WebGate.java'),
        'utf8'
    );

    /* 缺陷原貌：parts.get(0) 前没有 parts.isEmpty() 判断。
       纯 "/"（或 "/   "）解析后为空列表 → IndexOutOfBoundsException。
       实测 POST /web/chat/input input=/ 时会话帧记录
       "error: Index 0 out of bounds for length 0"。
       CliShell.isCommand 与 WsGate.handleCommand 一直有该守卫，只有 WebGate 漏。 */

    const fn = webGate.match(/private boolean isCommand\([\s\S]*?\n    \}/);
    assert.ok(fn, 'WebGate.isCommand 必须存在');
    const body = fn[0];

    assert.match(body, /parts\.isEmpty\(\)/,
        'isCommand 必须在 parts.get(0) 前判空，否则纯 / 会抛 IndexOutOfBoundsException');

    // 判空必须发生在取值之前
    const isEmptyIdx = body.indexOf('parts.isEmpty()');
    const getIdx = body.indexOf('String cmdName = parts.get(0)');
    assert.ok(isEmptyIdx >= 0 && getIdx > isEmptyIdx,
        '判空必须出现在 parts.get(0) 之前（顺序反了等于没守）');
});
